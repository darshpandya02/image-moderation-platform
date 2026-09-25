import { CATEGORIES, type Scores } from "@/lib/policy";

export function ScoreBars({ scores }: { scores: Scores }) {
  return (
    <div className="bars" data-testid="scores">
      {CATEGORIES.map((c) => {
        const v = scores[c] ?? 0;
        const hot = c === "porn" || c === "hentai" || c === "sexy";
        return (
          <div key={c} style={{ display: "contents" }}>
            <span className="muted">{c}</span>
            <div className={`bar${hot ? " hot" : ""}`}>
              <span style={{ width: `${Math.max(0.5, v * 100)}%` }} />
            </div>
            <span className="mono">{(v * 100).toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}
