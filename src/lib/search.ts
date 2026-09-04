import type { NormalizedProduct } from "@/types/product";
import { CATALOG } from "@/lib/catalog";

/** Damerau-Levenshtein distance with early bail-out (adjacent transposition
 *  counts as one edit), used for per-token typo tolerance. */
function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Adjacent transposition.
  if (la === lb && la > 1) {
    let diffAt = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        if (diffAt >= 0) {
          if (diffAt === i - 1 && a[diffAt] === b[i] && a[i] === b[diffAt]) {
            return a.slice(i + 1) === b.slice(i + 1);
          }
          return false;
        }
        diffAt = i;
      }
    }
    return true; // exactly one differing position
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  // One trailing extra char still counts as one edit.
  return edits + (la - i) + (lb - j) <= 1;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+]+/i)
    .filter(Boolean);
}

function tokenMatches(queryToken: string, fieldToken: string): boolean {
  if (fieldToken.startsWith(queryToken)) return true;
  if (queryToken.length >= 4 && editDistanceAtMost1(queryToken, fieldToken)) {
    return true;
  }
  return false;
}

/**
 * Score one product against tokenized query tokens.
 * Real queries often carry junk tokens (model numbers, noise), so we do not
 * require every token to match: at least half the tokens (and at least one)
 * must match; each unmatched token penalizes the score so cleaner queries
 * rank above noisy ones. Returns 0 when the product is not a relevant hit.
 */
function scoreProduct(
  product: NormalizedProduct,
  queryTokens: string[],
): number {
  const titleTokens = tokenize(product.title);
  const brandToken = product.brand.toLowerCase();
  const haystack = `${product.title} ${product.brand}`.toLowerCase();
  let score = 0;
  let matched = 0;

  for (const qt of queryTokens) {
    if (qt === brandToken) {
      score += 3;
      matched++;
      continue;
    }
    if (titleTokens.some((tt) => tokenMatches(qt, tt))) {
      score += 2;
      matched++;
      continue;
    }
    if (haystack.includes(qt)) {
      score += 1;
      matched++;
    }
  }
  if (matched === 0 || matched * 2 < queryTokens.length) return 0;
  return score - (queryTokens.length - matched);
}

export interface SearchResultPair {
  product: NormalizedProduct;
  score: number;
}

/**
 * Typo-tolerant, token-based search over the catalog.
 * All query tokens must match (AND); results are ranked by score then title.
 */
export function searchProducts(
  query: string,
  products: NormalizedProduct[] = CATALOG,
): SearchResultPair[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return products.map((p) => ({ product: p, score: 0 }));

  const matches: SearchResultPair[] = [];
  for (const product of products) {
    const score = scoreProduct(product, queryTokens);
    if (score > 0) matches.push({ product, score });
  }
  matches.sort(
    (a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title),
  );
  return matches;
}

/**
 * Nearest-match suggestions for the empty state: drop the least-matchable
 * tokens one at a time so "asus xa14 rog strix scope ii x" still suggests the
 * Strix Scope II keyboard.
 */
export function suggestProducts(
  query: string,
  products: NormalizedProduct[] = CATALOG,
  limit = 3,
): SearchResultPair[] {
  const direct = searchProducts(query, products);
  if (direct.length > 0) return direct.slice(0, limit);

  let tokens = tokenize(query);
  while (tokens.length > 1) {
    // Drop the token that, when removed, yields the best partial match.
    let best: { tokens: string[]; pairs: SearchResultPair[] } | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const candidate = [...tokens.slice(0, i), ...tokens.slice(i + 1)];
      const pairs = searchProducts(candidate.join(" "), products);
      if (pairs.length > 0 && (!best || pairs[0].score > best.pairs[0].score)) {
        best = { tokens: candidate, pairs };
      }
    }
    if (best) return best.pairs.slice(0, limit);
    tokens = tokens.slice(1); // no partial match: keep shrinking
  }
  return [];
}
