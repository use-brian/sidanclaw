"use client";

// [COMP:web/block-extraction-slot]
/**
 * Authoring directive block - `kind: 'extraction_slot'`, the "/extract" block.
 *
 * Carries a blueprint section's extraction INSTRUCTION: the text that tells the
 * synthesis engine what fills this section when the blueprint runs. The section
 * heading is the nearest preceding `heading` block. This block only appears in
 * blueprint templates, never in a filled / distilled page - so it renders as a
 * muted, dashed authoring panel (an editor-time directive, not page content),
 * visually distinct from real prose.
 *
 * Editable controls:
 *   1. `instruction` - a multi-line textarea (the "what to extract" prompt).
 *      Committed to the block on every change so it syncs through Yjs via the
 *      embed node-view's `updateBlock`.
 *   2. `outputType` - an optional shape hint (prose / list / table) chosen
 *      through the themed `Select` primitive (never a native `<select>`).
 *   3. Contract v2 (typed fields): `fieldKey` (the handoff address; auto from
 *      the heading when blank), `fieldType` (markdown / string / number / date
 *      / boolean / enum / entityRef), `options` for enum fields, `entityKind`
 *      for entityRef fields, and a `required` toggle that gates the record's
 *      `complete` status. All optional — an untouched slot stays a markdown
 *      field, so pre-v2 blueprints keep authoring identically.
 *
 * Rendered through the embed node-view's `renderEmbed` dispatch (the same path
 * as bookmark / image / child_page) - `extraction_slot` rides the opaque
 * `embed` atom, so there is no dedicated ProseMirror node and no Yjs schema
 * change. See docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * object".
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import type { ExtractionSlotBlock } from "@/lib/api/views";

/** The three output-shape hints, in display order. `auto` clears the field. */
const OUTPUT_TYPES = ["auto", "prose", "list", "table"] as const;
type OutputChoice = (typeof OUTPUT_TYPES)[number];

/** Contract v2 field types, in display order (markdown = the default). */
const FIELD_TYPES = ["markdown", "string", "number", "date", "boolean", "enum", "entityRef"] as const;
type FieldTypeChoice = (typeof FIELD_TYPES)[number];

const ENTITY_KINDS = ["company", "contact", "deal", "task"] as const;
type EntityKindChoice = (typeof ENTITY_KINDS)[number];

type Props = {
  block: ExtractionSlotBlock;
  readOnly?: boolean;
  onChange?: (patch: Partial<ExtractionSlotBlock>) => void;
};

export function BlockExtractionSlot({ block, readOnly, onChange }: Props) {
  const t = useT().docPage.extractionSlot;
  const [instruction, setInstruction] = useState<string>(block.instruction ?? "");
  const [fieldKey, setFieldKey] = useState<string>(block.fieldKey ?? "");
  const [optionsText, setOptionsText] = useState<string>((block.options ?? []).join(", "));

  // Base UI's <SelectValue> shows the raw value unless the Root gets an items
  // map; this label map makes the trigger render human-readable, localised text.
  const outputItems: Record<OutputChoice, string> = {
    auto: t.outputAuto,
    prose: t.outputProse,
    list: t.outputList,
    table: t.outputTable,
  };
  const typeItems: Record<FieldTypeChoice, string> = {
    markdown: t.typeMarkdown,
    string: t.typeString,
    number: t.typeNumber,
    date: t.typeDate,
    boolean: t.typeBoolean,
    enum: t.typeEnum,
    entityRef: t.typeEntityRef,
  };
  const entityKindItems: Record<EntityKindChoice, string> = {
    company: t.entityKindCompany,
    contact: t.entityKindContact,
    deal: t.entityKindDeal,
    task: t.entityKindTask,
  };

  const current: OutputChoice = block.outputType ?? "auto";
  const currentType: FieldTypeChoice = block.fieldType ?? "markdown";
  const currentEntityKind: EntityKindChoice = block.entityKind ?? "company";

  /** Keys are lowercase slugs; typing normalizes live so the block always
   *  carries a valid (or empty = derive-from-heading) key. */
  function commitFieldKey(raw: string) {
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+/, "")
      .slice(0, 64);
    setFieldKey(slug);
    onChange?.({ fieldKey: slug || undefined });
  }

  function commitOptions(raw: string) {
    setOptionsText(raw);
    const options = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    onChange?.({ options: options.length >= 2 ? options : undefined });
  }

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-foreground">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        <span className="uppercase tracking-wider">{t.label}</span>
      </div>
      <textarea
        value={instruction}
        readOnly={readOnly}
        rows={Math.min(8, Math.max(2, instruction.split("\n").length))}
        aria-label={t.instructionAria}
        placeholder={t.instructionPlaceholder}
        onChange={(e) => {
          const next = e.target.value;
          setInstruction(next);
          onChange?.({ instruction: next });
        }}
        className="w-full resize-y bg-transparent text-[16px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 read-only:cursor-default md:text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Field type — the contract's value type for this field. */}
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t.typeLabel}</span>
          <Select
            value={currentType}
            items={typeItems}
            disabled={readOnly}
            onValueChange={(v) => {
              if (!v) return;
              const nextType = v as FieldTypeChoice;
              // "markdown" maps back to an absent fieldType (the default);
              // switching away clears type-specific extras that no longer apply.
              onChange?.({
                fieldType: nextType === "markdown" ? undefined : nextType,
                ...(nextType !== "enum" ? { options: undefined } : {}),
                ...(nextType !== "entityRef" ? { entityKind: undefined } : {}),
              });
            }}
          >
            <SelectTrigger size="sm" className="min-w-28" aria-label={t.typeLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {FIELD_TYPES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {typeItems[choice]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>

        {/* Output shape hint — markdown fields only (it styles the prose). */}
        {currentType === "markdown" && (
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t.outputLabel}</span>
            <Select
              value={current}
              items={outputItems}
              disabled={readOnly}
              onValueChange={(v) => {
                if (!v) return;
                // "auto" maps back to an absent `outputType` (the engine picks the
                // shape); a concrete choice persists the enum.
                onChange?.({
                  outputType: v === "auto" ? undefined : (v as ExtractionSlotBlock["outputType"]),
                });
              }}
            >
              <SelectTrigger size="sm" className="min-w-28" aria-label={t.outputLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {OUTPUT_TYPES.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {outputItems[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        )}

        {/* Entity kind — entityRef fields only. */}
        {currentType === "entityRef" && (
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t.entityKindLabel}</span>
            <Select
              value={currentEntityKind}
              items={entityKindItems}
              disabled={readOnly}
              onValueChange={(v) => {
                if (!v) return;
                onChange?.({ entityKind: v as EntityKindChoice });
              }}
            >
              <SelectTrigger size="sm" className="min-w-28" aria-label={t.entityKindLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {ENTITY_KINDS.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {entityKindItems[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        )}

        {/* Field key — the stable handoff address; blank derives from the heading. */}
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t.fieldKeyLabel}</span>
          <input
            value={fieldKey}
            readOnly={readOnly}
            aria-label={t.fieldKeyAria}
            placeholder={t.fieldKeyPlaceholder}
            onChange={(e) => commitFieldKey(e.target.value)}
            className="w-36 rounded border border-border bg-transparent px-1.5 py-0.5 font-mono text-[16px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/50 read-only:cursor-default md:text-xs"
          />
        </span>

        {/* Required — gates the record's complete status. */}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={block.required ?? false}
            disabled={readOnly}
            onChange={(e) => onChange?.({ required: e.target.checked || undefined })}
            className="size-3.5 accent-foreground"
          />
          {t.requiredLabel}
        </label>
      </div>

      {/* Enum options — comma-separated authoring, persisted as a list. */}
      {currentType === "enum" && (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{t.optionsLabel}</span>
          <input
            value={optionsText}
            readOnly={readOnly}
            aria-label={t.optionsAria}
            placeholder={t.optionsPlaceholder}
            onChange={(e) => commitOptions(e.target.value)}
            className="w-full rounded border border-border bg-transparent px-1.5 py-0.5 text-[16px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/50 read-only:cursor-default md:text-xs"
          />
        </div>
      )}
    </div>
  );
}
