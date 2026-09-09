import {beforeEach,describe,it,expect,vi} from "vitest";
const api=vi.hoisted(()=>({fetch:vi.fn(),definitions:vi.fn(),purposes:vi.fn(),plans:vi.fn(),events:vi.fn()}));
vi.mock("@/lib/auth-fetch",()=>({authFetch:api.fetch}));
vi.mock("@/lib/api/crm",()=>({listCrmIntakeDefinitions:api.definitions,listCrmConsentPurposes:api.purposes,listCrmEntitlementPlans:api.plans,listCrmEvents:api.events}));
import {createCrmCredential,revokeCrmCredential,getCrmCredentialCatalog,getCrmScopeResources} from "@/lib/api/crm-administration";
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
beforeEach(()=>vi.resetAllMocks());
describe("[COMP:app-web/association] Credential catalog and member API",()=>{
  it("reads the actual server catalog and refuses unknown selector dimensions",async()=>{
    const catalog={operations:["crm.entitlements.read"],selectors:{"crm.entitlements.read":["planIds"]}};
    api.fetch.mockResolvedValueOnce(response(catalog));expect(await getCrmCredentialCatalog("w")).toEqual(catalog);
    api.fetch.mockResolvedValueOnce(response({...catalog,selectors:{"crm.entitlements.read":["unrecognized"]}}));await expect(getCrmCredentialCatalog("w")).rejects.toMatchObject({code:"invalid_response"});
  });
  it("keeps owner denial explicit rather than returning an empty permission catalog",async()=>{
    api.fetch.mockResolvedValue(response({error:"not_authorized"},403));await expect(getCrmCredentialCatalog("w")).rejects.toMatchObject({status:403,code:"not_authorized"});
  });
  it("issues and revokes only via authenticated member routes, preserving explicit rotation",async()=>{
    api.fetch.mockImplementation(async()=>response({oneTimeSecret:"fictional-secret"}));const input={label:"Fictional integration",expiresAt:"2028-01-01T00:00:00Z",grants:[{operation:"crm.records.read",selectors:{}}],revokeCredentialId:"old-id"};
    expect(await createCrmCredential("w",input)).toEqual({oneTimeSecret:"fictional-secret"});await revokeCrmCredential("w","credential/id");
    expect(new URL(api.fetch.mock.calls[0][0]).pathname).toBe("/api/crm/w/operations/integration-credentials");expect(JSON.parse(api.fetch.mock.calls[0][1].body)).toEqual(input);
    expect(new URL(api.fetch.mock.calls[1][0]).pathname).toBe("/api/crm/w/operations/integration-credentials/credential%2Fid/revoke");expect(api.fetch.mock.calls[0][1].headers).toEqual({"Content-Type":"application/json"});
  });
  it("uses complete CRM catalog readers and exposes no definition or consent payloads",async()=>{
    api.definitions.mockResolvedValue(Array.from({length:103},(_,i)=>({id:`definition-${i}`,label:`Definition ${i}`,fields:["private-schema"]})));
    api.purposes.mockResolvedValue([{purposeKey:"updates",label:"Updates",defaultWording:"private-wording"}]);api.plans.mockResolvedValue([{id:"plan",name:"Plan"}]);api.events.mockResolvedValue([{id:"event",title:"Event"}]);
    const result=await getCrmScopeResources("w");expect(result.definitionIds).toHaveLength(103);expect(result.definitionIds[102]).toEqual({id:"definition-102",label:"Definition 102"});expect(result.purposeKeys).toEqual([{id:"updates",label:"Updates"}]);
    for(const call of [api.definitions,api.purposes,api.plans,api.events])expect(call).toHaveBeenCalledExactlyOnceWith("w");
  });
});
