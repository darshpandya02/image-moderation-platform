import { getDb } from "@/lib/db";
import { CATEGORIES } from "@/lib/policy";
import { listPolicies } from "@/lib/services/policies";

export const dynamic = "force-dynamic";

const pct = (v: number | undefined) => (v === undefined ? "none" : `${Math.round(v * 100)}%`);

export default async function PoliciesPage() {
  const policies = await listPolicies(getDb());
  return (
    <>
      <h1>Policies</h1>
      <p className="lead">
        A score at or above a category&apos;s reject threshold rejects the image; at or above its review threshold it
        goes to a reviewer. Reject wins over review. Categories without a rule never affect the decision.
      </p>
      {policies.map((p) => (
        <section key={p.id} className="panel" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>
            {p.name} <code className="muted">{p.id}</code> {p.isDefault && <span className="badge approved">default</span>}
          </h2>
          <p className="muted">{p.description}</p>
          <table>
            <thead>
              <tr>
                <th>category</th>
                <th>review at</th>
                <th>reject at</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((c) => (
                <tr key={c}>
                  <td>{c}</td>
                  <td className="mono">{pct(p.thresholds[c]?.review)}</td>
                  <td className="mono">{pct(p.thresholds[c]?.reject)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
