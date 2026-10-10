import { type ReactNode, useEffect, useRef } from "react";

// A modal built on the native <dialog>, which traps focus and closes on Escape by itself.
// Rendered only while open; clicking the dimmed backdrop also closes it.
export function Dialog({
  onClose,
  labelledBy,
  variant = "modal",
  children,
}: {
  onClose: () => void;
  labelledBy: string;
  variant?: "modal" | "sheet";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a native dialog.
    <dialog
      ref={ref}
      className={variant}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
