import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/queries";
import { isReviewer } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  if (!(await isReviewer())) redirect("/review");
  const entries = await listAudit(getDb(), { limit: 200 });
  return (
    <>
      <p>
        <Link href="/review">Back to queue</Link>
      </p>
      <h1>Audit log</h1>
      <p className="lead">Latest 200 entries. System decisions and reviewer actions are recorded in the same table.</p>
      <table data-testid="audit-table">
        <thead>
          <tr>
            <th>time</th>
            <th>image</th>
            <th>actor</th>
            <th>action</th>
            <th>transition</th>
            <th>note / details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="mono">{new Date(e.at).toISOString().replace("T", " ").slice(0, 19)}</td>
              <td className="mono">{e.imageId ? <Link href={`/images/${e.imageId}`}>{e.imageId.slice(0, 8)}</Link> : "-"}</td>
              <td>{e.actor}</td>
              <td>{e.action}</td>
              <td className="mono">
                {e.from ?? "-"} → {e.to ?? "-"}
              </td>
              <td className="muted">{e.note ?? (Object.keys(e.details).length ? JSON.stringify(e.details) : "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
