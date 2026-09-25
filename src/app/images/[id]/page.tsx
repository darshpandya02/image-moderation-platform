import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusView } from "@/components/StatusView";
import { getDb } from "@/lib/db";
import { getImageStatus } from "@/lib/services/queries";

export const dynamic = "force-dynamic";

export default async function ImagePage({ params }: PageProps<"/images/[id]">) {
  const { id } = await params;
  const status = await getImageStatus(getDb(), id);
  if (!status) notFound();
  return (
    <>
      <p>
        <Link href="/">Back to upload</Link>
      </p>
      <h1>
        Image <code>{id.slice(0, 8)}</code>
      </h1>
      <StatusView initial={status} />
    </>
  );
}
