import Link from "next/link";
import { LoginForm, LogoutButton } from "@/components/LoginForm";
import { ReviewQueue } from "@/components/ReviewQueue";
import { getDb } from "@/lib/db";
import { listReviewQueue } from "@/lib/services/queries";
import { isReviewer } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  if (!(await isReviewer())) {
    return (
      <>
        <h1>Reviewer queue</h1>
        <p className="lead">Reviewer access is password protected. The demo password is listed in the project README.</p>
        <LoginForm />
      </>
    );
  }
  const items = await listReviewQueue(getDb());
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Reviewer queue</h1>
        <div className="row">
          <Link href="/review/audit">Audit log</Link>
          <LogoutButton />
        </div>
      </div>
      <p className="lead">
        {items.length} image{items.length === 1 ? "" : "s"} flagged for human review, oldest first. Every decision is
        written to the audit log.
      </p>
      <ReviewQueue items={items} />
    </>
  );
}
