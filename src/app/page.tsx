import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Reemco</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Compare prices across merchants — offers, coupons, and alternatives.
      </p>
      <Link
        href="/search"
        className="rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90"
      >
        Start a search
      </Link>
    </div>
  );
}
