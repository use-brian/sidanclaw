/** Native owner administration; never uses a machine credential. [COMP:app-web/association] */
import { authFetch } from "@/lib/auth-fetch";
import { listCrmIntakeDefinitions,listCrmConsentPurposes,listCrmEntitlementPlans,listCrmEvents } from "./crm";
import { AssociationApiError } from "./association";
const API_URL=process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
async function request<T>(workspaceId:string,path:string,input?:unknown):Promise<T>{
  const response=await authFetch(`${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/operations/${path}`,input===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json();if(!response.ok)throw new AssociationApiError(typeof body?.error==="string"?body.error:"unavailable",response.status);return body as T;
}
export type CrmScopeDimension="definitionIds"|"purposeKeys"|"planIds"|"eventIds"|"providerKeys";
export type CrmCredentialGrant={operation:string;selectors:Partial<Record<CrmScopeDimension,"all"|string[]>>};
export type CrmManagedCredential={id:string;label:string;prefix:string;expiresAt:string;revokedAt:string|null;createdAt:string;lastUsedAt:string|null;grants:CrmCredentialGrant[]};
export type CrmCredentialCatalog={operations:string[];selectors:Record<string,CrmScopeDimension[]>};
export async function getCrmCredentialCatalog(workspaceId:string):Promise<CrmCredentialCatalog>{
  const catalog=await request<CrmCredentialCatalog>(workspaceId,"integration-credentials/catalog");
  const dimensions=new Set(["definitionIds","purposeKeys","planIds","eventIds","providerKeys"]);
  if(!Array.isArray(catalog.operations)||!catalog.operations.length||!catalog.selectors||catalog.operations.some(op=>typeof op!=="string"||!Array.isArray(catalog.selectors[op])||catalog.selectors[op].some(d=>!dimensions.has(d))))throw new AssociationApiError("invalid_response",502);
  return catalog;
}
export function createCrmCredential(workspaceId:string,input:{label:string;expiresAt:string;grants:CrmCredentialGrant[];revokeCredentialId?:string}){
  return request<CrmManagedCredential&{oneTimeSecret:string}>(workspaceId,"integration-credentials",input);
}
export function revokeCrmCredential(workspaceId:string,credentialId:string){return request<{revoked:boolean}>(workspaceId,`integration-credentials/${encodeURIComponent(credentialId)}/revoke`,{});}
export async function getCrmScopeResources(workspaceId:string){
  const [definitions,purposes,plans,events]=await Promise.all([listCrmIntakeDefinitions(workspaceId),listCrmConsentPurposes(workspaceId),listCrmEntitlementPlans(workspaceId),listCrmEvents(workspaceId)]);
  return {definitionIds:definitions.map(r=>({id:r.id,label:r.label})),purposeKeys:purposes.map(r=>({id:r.purposeKey,label:r.label})),planIds:plans.map(r=>({id:r.id,label:r.name})),eventIds:events.map(r=>({id:r.id,label:r.title}))};
}

export type CrmManagedMailboxPolicy={connectorInstanceId:string;providerKey:string;version:number;managed:boolean;purposeKeys:string[];templatePurposes:Record<string,string>};
export type CrmMailboxIntegrationGrant={credentialId:string;connectorInstanceId:string;version:number;enabled:boolean};
export async function listCrmMailboxes(workspaceId:string):Promise<Array<{id:string;label:string;provider:string}>>{
  const response=await authFetch(`${API_URL}/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`);
  if(!response.ok)throw new AssociationApiError("mailboxes_unavailable",response.status);
  const body=await response.json();if(!Array.isArray(body?.connectors))throw new AssociationApiError("invalid_response",502);
  // Intentionally only the three prepared transports, not every built-in connector.
  return body.connectors.filter((row:{id?:unknown;connectorInstanceId?:unknown})=>["gmail","imap","agentmail"].includes(String(row.id))&&typeof row.connectorInstanceId==="string")
    .map((row:{id:string;connectorInstanceId:string;label?:string;name:string;connectedEmail?:string})=>({id:row.connectorInstanceId,provider:row.id,label:row.label||row.connectedEmail||row.name}));
}
export function getCrmMailboxPolicy(workspaceId:string,instanceId:string){return request<{policy:CrmManagedMailboxPolicy|null}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}`);}
export function saveCrmMailboxPolicy(workspaceId:string,instanceId:string,input:Omit<CrmManagedMailboxPolicy,"connectorInstanceId"|"version">&{expectedVersion:number;confirmed:true}){return request<{record:CrmManagedMailboxPolicy}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}`,input);}
export function getCrmMailboxGrant(workspaceId:string,instanceId:string,credentialId:string){return request<{grant:CrmMailboxIntegrationGrant|null}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}/integration-grants/${encodeURIComponent(credentialId)}`);}
export function saveCrmMailboxGrant(workspaceId:string,instanceId:string,credentialId:string,input:{expectedVersion:number;confirmed:true;enabled:boolean}){return request<{record:CrmMailboxIntegrationGrant}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}/integration-grants/${encodeURIComponent(credentialId)}`,input);}
