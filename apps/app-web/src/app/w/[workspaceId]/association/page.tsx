"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { AssociationSurface } from "@/components/association/association-surface";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";

export default function AssociationPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <Suspense fallback={<SurfaceSkeletonFor surface="association" />}><AssociationSurface key={workspaceId} workspaceId={workspaceId} /></Suspense>;
}
