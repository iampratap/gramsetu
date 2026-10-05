import { useEffect } from "react";

export function PageHead({ eyebrow, title, lede, children }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function Banner({ children }) {
  if (!children) return null;
  return <div className="banner" role="alert">{children}</div>;
}

export function Badge({ value, children }) {
  const tone = String(value || children || "neutral").toLowerCase().replace(/\s+/g, "-");
  return <span className={`badge tone-${tone}`}>{children || value}</span>;
}

export function Empty({ title, lede }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {lede ? <p>{lede}</p> : null}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function Modal({ title, lede, onClose, children }) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    document.body.classList.add("modal-open");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {lede ? <p>{lede}</p> : null}
          </div>
          <button className="btn ghost small" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="4" fill="#0d47a1" />
      <path d="M9 28c7-11 23-11 30 0" fill="none" stroke="#ffffff" strokeWidth="2.4" />
      <path d="M15 28c4.4-6.2 13.6-6.2 18 0" fill="none" stroke="#ffffff" strokeWidth="2.4" />
      <circle cx="24" cy="28" r="2.3" fill="#ffffff" />
      <path d="M24 30.5v7" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Pagination({ meta, onPageChange }) {
  if (!meta || meta.total === 0) return null;
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.page * meta.pageSize, meta.total);
  return (
    <div className="pagination">
      <p className="muted">
        Showing {from}–{to} of {meta.total}
      </p>
      <div className="pagination-actions">
        <button
          className="btn ghost small"
          type="button"
          disabled={!meta.hasPrev}
          onClick={() => onPageChange(meta.page - 1)}
        >
          Previous
        </button>
        <span className="muted">
          Page {meta.page} of {meta.pageCount}
        </span>
        <button
          className="btn ghost small"
          type="button"
          disabled={!meta.hasNext}
          onClick={() => onPageChange(meta.page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
