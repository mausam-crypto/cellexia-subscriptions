/**
 * Branded product card: circular initial "thumb", title, meta line
 * (quantity × cadence), optional supply hint and price, plus a controls slot.
 */
import type { ReactNode } from "react";
import { productInitial } from "~/components/portal/logic";

export function ProductCard({
  title,
  meta,
  supplyLabel,
  priceLabel,
  children,
}: {
  title: string;
  meta?: string | null;
  supplyLabel?: string | null;
  priceLabel?: string | null;
  children?: ReactNode;
}) {
  return (
    <article className="cx-product-card">
      <div className="cx-product-thumb" aria-hidden="true">
        {productInitial(title)}
      </div>
      <div className="cx-product-card__body">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <h3 className="cx-product-card__title">{title}</h3>
          {priceLabel ? (
            <span className="cx-product-card__price">{priceLabel}</span>
          ) : null}
        </div>
        {meta ? <p className="cx-product-card__meta">{meta}</p> : null}
        {supplyLabel ? (
          <p className="cx-product-card__meta">Supply: {supplyLabel}</p>
        ) : null}
        {children ? (
          <div className="cx-product-card__controls">{children}</div>
        ) : null}
      </div>
    </article>
  );
}
