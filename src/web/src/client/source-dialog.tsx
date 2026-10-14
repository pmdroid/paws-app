import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import type { SourceChoice } from "../source";

export function createSourceDialog(apply: (choice: SourceChoice) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function SourceDialog({ help }: { help: string }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Status source</DialogTitle>
          <DialogDescription>{help}</DialogDescription>
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
            <Button
              type="button"
              onClick={() => {
                apply({ kind: "auto" });
                setOpen(false);
              }}
            >
              Use this engine
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
  return {
    open(help: string) {
      flushSync(() => root.render(<SourceDialog key={Date.now()} help={help} />));
    },
  };
}
