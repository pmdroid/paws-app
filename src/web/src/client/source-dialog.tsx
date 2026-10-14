import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { parseEngineUrl } from "../endpoint";
import type { SourceChoice } from "../source";

export function createSourceDialog(apply: (choice: SourceChoice) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function SourceDialog({ initial, help }: { initial: string; help: string }) {
    const [open, setOpen] = useState(true);
    const [error, setError] = useState("");
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Status source</DialogTitle>
          <DialogDescription>{help}</DialogDescription>
          <form
            id="source-form"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const raw = String(new FormData(event.currentTarget).get("engine") ?? "").trim();
              const url = parseEngineUrl(raw);
              if (raw && !url) {
                setError("Enter an http or https URL, or leave the field empty.");
                return;
              }
              apply(url ? { kind: "engine", url } : { kind: "auto" });
              setOpen(false);
            }}
          >
            <label htmlFor="source-engine" className="text-sm font-semibold">
              Engine URL
            </label>
            <Input
              id="source-engine"
              name="engine"
              defaultValue={initial}
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8787"
            />
            <p className="text-sm leading-relaxed">
              Leave this empty and save to choose automatically. When this page is served at
              /status, that reads this engine. Demo data is only shown when you choose it.
            </p>
            <p className="text-sm font-bold" role="alert">
              {error}
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                type="button"
                variant="neutral"
                onClick={() => {
                  apply({ kind: "demo" });
                  setOpen(false);
                }}
              >
                Use demo data
              </Button>
              <Button type="button" variant="neutral" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    );
  }
  return {
    open(initial: string, help: string) {
      flushSync(() => root.render(<SourceDialog key={Date.now()} initial={initial} help={help} />));
    },
  };
}
