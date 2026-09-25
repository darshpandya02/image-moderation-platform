"""End-to-end browser check against a running deployment.

Usage:
  uv run --with playwright --python 3.12 python e2e/verify.py <base-url> <image> [reviewer-password]

1. Uploads an image under the default policy through the real UI and waits
   for the live status to reach "decided / approved"; checks the gallery.
2. Uploads again under the strict demo policy, which routes it to review.
3. Signs in to the reviewer page, approves that item with a note, and checks
   the audit log recorded it.
"""

import sys
import time

from playwright.sync_api import expect, sync_playwright

base = sys.argv[1].rstrip("/")
image = sys.argv[2]
password = sys.argv[3] if len(sys.argv) > 3 else "moderate-demo-2026"


def upload(page, policy: str) -> tuple[str, float, str]:
    page.goto(base + "/")
    page.set_input_files("input[type=file]", image)
    page.select_option("select[name=policy]", policy)
    t0 = time.perf_counter()
    page.click("button[type=submit]")
    page.wait_for_url("**/images/*", timeout=60_000)
    stages = []
    stage = page.get_by_test_id("stage")
    deadline = time.time() + 90
    while time.time() < deadline:
        s = stage.text_content()
        if not stages or stages[-1] != s:
            stages.append(s)
        if s in ("decided", "failed"):
            break
        time.sleep(0.1)
    elapsed = time.perf_counter() - t0
    decision = page.get_by_test_id("decision").text_content()
    image_id = page.url.rsplit("/", 1)[-1]
    print(f"  {policy}: id={image_id} stages seen={stages} decision={decision} in {elapsed:.2f}s")
    return image_id, elapsed, decision


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context()
    page = ctx.new_page()

    home = page.goto(base + "/")
    print(f"GET / -> {home.status}")
    assert home.status == 200, "production must be reachable without authentication"

    print("1) default policy upload")
    approved_id, _, decision = upload(page, "default")
    assert decision == "approved", decision
    expect(page.locator("img[alt='approved upload']")).to_be_visible()
    page.goto(base + "/")
    expect(page.locator(f"[data-image-id='{approved_id}']")).to_be_visible()
    print("  approved image is in the gallery")

    print("2) strict demo policy upload")
    flagged_id, _, decision = upload(page, "strict-demo")
    assert decision == "needs_review", decision
    page.goto(base + "/")
    assert page.locator(f"[data-image-id='{flagged_id}']").count() == 0, "flagged image must not be in the gallery"
    r = page.request.get(f"{base}/api/images/{flagged_id}/file")
    assert r.status == 404, f"unapproved file must not be public, got {r.status}"
    print("  flagged image hidden from gallery and file endpoint (404)")

    print("3) reviewer")
    r = page.request.get(f"{base}/api/review/queue")
    assert r.status == 401, f"review API must require login, got {r.status}"
    page.goto(base + "/review")
    page.fill("input[name=password]", "wrong-password")
    page.click("[data-testid=login-form] button")
    expect(page.locator("[data-testid=login-form] .error")).to_be_visible()
    page.fill("input[name=password]", password)
    page.click("[data-testid=login-form] button")
    item = page.locator(f"[data-review-id='{flagged_id}']")
    expect(item).to_be_visible(timeout=15_000)
    item.locator("input[type=text]").fill("e2e check: benign test photo")
    item.locator("button.approve").click()
    expect(item.get_by_test_id("review-result")).to_have_text("approved")
    print("  approved flagged item from the queue")

    page.goto(base + "/review/audit")
    row = page.locator("tr", has_text=flagged_id[:8]).filter(has_text="review_approve")
    expect(row.first).to_be_visible()
    print("  audit log has the review_approve entry")
    page.goto(base + "/")
    expect(page.locator(f"[data-image-id='{flagged_id}']")).to_be_visible()
    print("  reviewed image now in the gallery")

    browser.close()
    print("ALL CHECKS PASSED")
