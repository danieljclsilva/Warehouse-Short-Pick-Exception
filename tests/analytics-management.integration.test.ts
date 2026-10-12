import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, closeDb } from "@/db";
import { caseEvents, checkTasks, configurationVersions, orderCases, shortPickLines, sessions, users } from "@/db/schema";
import { defaultPermissions } from "@/domain/permissions";
import { periodChange, previousReportingPeriod } from "@/domain/analytics-management";
import { createSession } from "@/server/auth";
import { hashPin } from "@/server/security";
import { GET } from "@/app/api/analytics/route";
import { GET as csvRoute } from "@/app/api/analytics/export/csv/route";

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip;
describe("comparison period mathematics", () => {
  it("uses the full inclusive-calendar range duration, without overlap", () => {
    expect(previousReportingPeriod(new Date("2026-10-01"), new Date("2026-10-12")))
      .toEqual({ from: new Date("2026-09-20"), toExclusive: new Date("2026-10-01") });
  });
  it("handles zero baselines and signed changes without infinity", () => {
    expect(periodChange(4, 0)).toEqual({ current: 4, previous: 0, delta: 4, percentage: null });
    expect(periodChange(0, 0).percentage).toBeNull();
    expect(periodChange(5, 10).percentage).toBe(-50);
    expect(periodChange(12, 8).percentage).toBe(50);
  });
});

databaseDescribe("management analytics against PostgreSQL", () => {
  const suffix = randomUUID().slice(0, 8);
  const caseIds: string[] = [], lineIds: string[] = [], userIds: string[] = [];
  const orderPrefix = `990${parseInt(suffix, 16)}`;
  const orderA = `${orderPrefix}1`, orderB = `${orderPrefix}2`;
  let cookie = "", pickerCookie = "", adminId = "", configId = "";
  const path = "/api/analytics?from=2026-10-01&to=2026-10-11";
  async function create(order: string, created: string, phase: "PICKING" | "STAGED" | "CLOSED", resolved?: string, assigned = false, lineCount = 1) {
    const [c] = await getDb().insert(orderCases).values({ orderNumber: order, phase,
      physicalState: phase === "PICKING" ? "WITH_PICKER" : "SHORT_PICK_HOLD", source: "TL_MANUAL", createdByUserId: adminId,
      configurationVersionId: configId, currentCaseResponsibleUserId: assigned ? adminId : null,
      createdAt: new Date(created), resolvedAt: resolved ? new Date(resolved) : null }).returning();
    caseIds.push(c!.id);
    for (let i = 0; i < lineCount; i++) {
      const [line] = await getDb().insert(shortPickLines).values({ caseId: c!.id, originalLocation: `MGMT-0${i+1}`, sku: `MGMT-${suffix.toUpperCase()}`,
        missingQuantity: 1, reportedByUserId: adminId, reportedAt: new Date(created) }).returning();
      lineIds.push(line!.id);
    }
    return c!;
  }
  beforeAll(async () => {
    const [config] = await getDb().select().from(configurationVersions).limit(1);configId = config!.id;
    for (const role of ["ADMIN", "PICKER"] as const) {
      const [user] = await getDb().insert(users).values({identifier:`management-${suffix}-${role}`,displayName:`Management ${role}`,role,
        permissions:defaultPermissions(role),pinHash:await hashPin("123456")}).returning();
      userIds.push(user!.id);
      const sessionCookie=(await createSession(user!.id)).cookie.split(";")[0]!;
      if(role==="ADMIN"){adminId=user!.id;cookie=sessionCookie;} else pickerCookie=sessionCookie;
    }
    await create(orderA,"2026-01-01T08:00:00Z","CLOSED","2026-01-01T10:00:00Z");
    await create(orderA,"2026-09-25T08:00:00Z","CLOSED","2026-09-25T10:00:00Z");
    await create(orderA,"2026-10-05T08:00:00Z","CLOSED","2026-10-05T10:00:00Z",false,2);
    await create(orderB,"2026-01-15T08:00:00Z","PICKING");
    await create(orderB,"2026-10-09T08:00:00Z","CLOSED","2026-10-09T10:00:00Z");
    await create(`${orderPrefix}3`,"2026-09-27T08:00:00Z","CLOSED","2026-10-06T10:00:00Z");
    await create(`${orderPrefix}4`,"2026-10-07T08:00:00Z","STAGED");
    await create(`${orderPrefix}5`,"2026-02-01T08:00:00Z","STAGED",undefined,true);
  });
  afterAll(async () => {
    const db=getDb();
    if(caseIds.length)await db.delete(caseEvents).where(inArray(caseEvents.caseId,caseIds));
    if(lineIds.length){await db.delete(checkTasks).where(inArray(checkTasks.shortPickLineId,lineIds));await db.delete(shortPickLines).where(inArray(shortPickLines.id,lineIds));}
    if(caseIds.length)await db.delete(orderCases).where(inArray(orderCases.id,caseIds));
    if(userIds.length){await db.delete(sessions).where(inArray(sessions.userId,userIds));await db.delete(users).where(inArray(users.id,userIds));}
    await closeDb();
  });
  async function data(extra="") {
    const response=await GET(new Request(`http://localhost${path}&sku=MGMT-${suffix.toUpperCase()}${extra}`,{headers:{cookie}}));
    expect(response.status).toBe(200);return response.json();
  }
  it("compares complete report cohorts and closure-date throughput with identical filters",async()=>{
    const result=await data();
    expect(result.management.comparison.current).toMatchObject({from:"2026-10-01T00:00:00.000Z",toExclusive:"2026-10-12T00:00:00.000Z",cases:3,lines:4,resolvedCases:3});
    expect(result.management.comparison.previous).toMatchObject({from:"2026-09-20T00:00:00.000Z",toExclusive:"2026-10-01T00:00:00.000Z",cases:2,lines:2,resolvedCases:1});
    expect(result.management.comparison.changes.cases.percentage).toBe(50);
    expect(result.management.comparison.changes.resolvedCases.percentage).toBe(200);
  });
  it("uses all open warehouse cases, including old cases outside every dashboard filter",async()=>{
    const result=await data("&orderNumber=no-match");
    expect(result.kpis.totalCases).toBe(0);
    expect(result.management.backlog).toMatchObject({totalOpen:3,picking:1,staged:2,unassignedStaged:1,evaluatedCases:3,truncated:false,oldestCreatedAt:"2026-01-15T08:00:00.000Z"});
    expect(Object.values(result.management.backlog.aging).reduce<number>((sum,n)=>sum+Number(n),0)).toBe(3);
    expect(result.management.lifetimeRecurrence.repeatedOrderCount).toBe(0);
  });
  it("finds lifetime recurrence when only one occurrence is in the selected period",async()=>{
    const result=await data();
    expect(result.duplicates.repeatedOrderCount).toBe(0);
    expect(result.management.lifetimeRecurrence.repeatedOrderCount).toBe(2);
    const a=result.management.lifetimeRecurrence.orders.find((o:{orderNumber:string})=>o.orderNumber===orderA);
    expect(a).toMatchObject({occurrences:3,selectedPeriodOccurrences:1,firstSeenAt:"2026-01-01T08:00:00.000Z",lastSeenAt:"2026-10-05T08:00:00.000Z",datesTruncated:false});
    expect(a.cases).toHaveLength(3);
    const narrowed=await data(`&orderNumber=${orderB}&phase=CLOSED`);
    expect(narrowed.management.lifetimeRecurrence.orders[0]).toMatchObject({orderNumber:orderB,occurrences:2,selectedPeriodOccurrences:1});
  });
  it("enforces analytics permission before returning warehouse-wide information",async()=>{
    const response=await GET(new Request(`http://localhost${path}`,{headers:{cookie:pickerCookie}}));expect(response.status).toBe(403);
    expect((await response.json()).management).toBeUndefined();
  });
  it("exports the same scopes through the permission-gated management CSV",async()=>{
    const response=await csvRoute(new Request(`http://localhost/api/analytics/export/csv?dataset=management&from=2026-10-01&to=2026-10-11&sku=MGMT-${suffix.toUpperCase()}`,{headers:{cookie}}));
    expect(response.status).toBe(200);const csv=await response.text();
    expect(csv).toContain("comparison_current");expect(csv).toContain("warehouse_backlog");expect(csv).toContain("lifetime_recurrence");expect(csv).toContain(orderA);
  });
  it("retains exact global totals above the working-age display cap", async()=>{
    const extraIds:string[]=[];
    try {
      for(let start=0;start<5001;start+=500){
        const rows=Array.from({length:Math.min(500,5001-start)},(_,index)=>({orderNumber:`${orderPrefix}8${start+index}`,phase:"PICKING" as const,physicalState:"WITH_PICKER" as const,createdByUserId:adminId,configurationVersionId:configId,createdAt:new Date("2026-01-02T08:00:00Z")}));
        extraIds.push(...(await getDb().insert(orderCases).values(rows).returning({id:orderCases.id})).map(row=>row.id));
      }
      const result=await data("&orderNumber=no-match");
      expect(result.management.backlog).toMatchObject({totalOpen:5004,picking:5002,staged:2,evaluatedCases:5000,truncated:true});
    } finally {if(extraIds.length)await getDb().delete(orderCases).where(inArray(orderCases.id,extraIds));}
  });
  it("retains exact lifetime count and first/last dates when historical detail is capped", async()=>{
    const extraIds:string[]=[];
    try {
      for(let start=0;start<5001;start+=500){
        const rows=Array.from({length:Math.min(500,5001-start)},()=>({orderNumber:orderA,phase:"CLOSED" as const,physicalState:"SHORT_PICK_HOLD" as const,createdByUserId:adminId,configurationVersionId:configId,createdAt:new Date("2000-01-01T08:00:00Z"),resolvedAt:new Date("2000-01-01T09:00:00Z")}));
        extraIds.push(...(await getDb().insert(orderCases).values(rows).returning({id:orderCases.id})).map(row=>row.id));
      }
      const result=await data(`&orderNumber=${orderA}`);
      expect(result.management.lifetimeRecurrence).toMatchObject({repeatedOrderCount:1,groupsTruncated:false,datesTruncated:true});
      expect(result.management.lifetimeRecurrence.orders[0]).toMatchObject({occurrences:5004,selectedPeriodOccurrences:1,firstSeenAt:"2000-01-01T08:00:00.000Z",lastSeenAt:"2026-10-05T08:00:00.000Z",datesTruncated:true});
      expect(result.management.lifetimeRecurrence.orders[0].cases).toHaveLength(5000);
    } finally {if(extraIds.length)await getDb().delete(orderCases).where(inArray(orderCases.id,extraIds));}
  });

  it("compares exact report counts even above the cohort row cap", async()=>{
    const extraIds:string[]=[];
    try {
      for(let start=0;start<5001;start+=500){
        const rows=Array.from({length:Math.min(500,5001-start)},(_,index)=>({orderNumber:`${orderPrefix}9${start+index}`,phase:"CLOSED" as const,physicalState:"SHORT_PICK_HOLD" as const,createdByUserId:adminId,configurationVersionId:configId,createdAt:new Date("2026-10-04T08:00:00Z"),resolvedAt:new Date("2026-10-04T09:00:00Z")}));
        extraIds.push(...(await getDb().insert(orderCases).values(rows).returning({id:orderCases.id})).map(row=>row.id));
      }
      const response=await GET(new Request(`http://localhost${path}`,{headers:{cookie}}));
      expect(response.status).toBe(200);const result=await response.json();
      expect(result.rows.cases).toHaveLength(5000);expect(result.limits.casesTruncated).toBe(true);
      expect(result.management.comparison.current).toMatchObject({cases:5004,lines:4,resolvedCases:5004});
      expect(result.management.comparison.previous).toMatchObject({cases:2,lines:2,resolvedCases:1});
    } finally {if(extraIds.length)await getDb().delete(orderCases).where(inArray(orderCases.id,extraIds));}
  });

});
