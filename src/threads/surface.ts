import type { ThreadContextKind, ThreadSurfaceKind } from "../db";

export type ThreadCapability = "post" | "react" | "code_view";

export type ThreadDestination = {
  surface: ThreadSurfaceKind;
  installationId: string;
  kind: ThreadContextKind;
  channelId: string;
  threadId: string | null;
  privateMember: string | null;
};

export type ThreadEffect =
  | { kind: "post"; effectKey: string; text: string; questionId?: string }
  | { kind: "react"; effectKey: string; messageId: string; emoji: string }
  | { kind: "code_view"; effectKey: string; view: unknown; fallbackText: string };

export interface ThreadSurface {
  readonly kind: ThreadSurfaceKind;
  readonly capabilities: ReadonlySet<ThreadCapability>;
  delivered(destination: ThreadDestination, effectKey: string): Promise<string | null>;
  post(destination: ThreadDestination, input: { effectKey: string; text: string }): Promise<string>;
  react?(
    destination: ThreadDestination,
    input: { effectKey: string; messageId: string; emoji: string },
  ): Promise<string>;
  showCodeView?(
    destination: ThreadDestination,
    input: { effectKey: string; view: unknown },
  ): Promise<string>;
}
