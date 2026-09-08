// @vitest-environment jsdom
/**
 * REEA-181 — footer trust-pages coverage. Guards the three shipped
 * behaviors: each static page server-renders its real h1 + copy inside the
 * shared StaticPage shell, every footer label points at its own route (was:
 * three copies of href="/"), and aria-current="page" lands on the anchor
 * matching the current route. Mock style follows ResultsClient.test.tsx.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import AboutPage from "@/app/about/page";
import PrivacyPage from "@/app/privacy/page";
import ContactPage from "@/app/contact/page";
import FooterNav from "@/components/FooterNav";

afterEach(cleanup);

describe("static trust pages (REEA-181)", () => {
  it("/about server-renders its h1 and all three labeled blocks", async () => {
    render(await AboutPage());
    expect(screen.getByRole("heading", { name: "About Reemco" })).toBeTruthy();
    expect(screen.getByText(/price-comparison site for shopping in Kuwait/)).toBeTruthy();
    expect(
      screen.getByText(
        "Xcite · Jarir · Eureka · Sultan Center · Blink · Lulu Hypermarket · Quadra Stores · Next Store · PC Kuwait.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/fetched live from each retailer/)).toBeTruthy();
  });

  it("/privacy server-renders its h1, lead line and blocks", async () => {
    render(await PrivacyPage());
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeTruthy();
    expect(screen.getByText(/what Reemco records, and why/)).toBeTruthy();
    expect(screen.getByText(/anonymous counts and click-outs/)).toBeTruthy();
  });

  it("/contact server-renders its h1, mailto link and supporting lines", async () => {
    render(await ContactPage());
    expect(screen.getByRole("heading", { name: "Contact" })).toBeTruthy();
    const mail = screen.getByRole("link", { name: "support@reemco.example" });
    expect(mail.getAttribute("href")).toBe("mailto:support@reemco.example");
    expect(mail.getAttribute("style")).toMatch(/overflow(-|W)wrap:\s*anywhere/);
    expect(screen.getByText(/reply within one business day/)).toBeTruthy();
  });
});

describe("footer nav (REEA-181)", () => {
  it("points each label at its own route instead of the shared '/'", () => {
    pathname = "/";
    const { container } = render(<FooterNav />);
    const anchors = [...container.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Footer'] a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["/about", "/privacy", "/contact"]);
    expect(anchors.every((a) => a.getAttribute("aria-current") === null)).toBe(true);
  });

  it("marks only the matching route aria-current='page'", () => {
    pathname = "/privacy";
    render(<FooterNav />);
    expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "About" }).getAttribute("aria-current")).toBeNull();
  });
});
