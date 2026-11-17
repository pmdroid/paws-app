import type { ThreadSurfaceKind } from "../db";
import type { ThreadCapability, ThreadDestination, ThreadSurface } from "./surface";

export type FakeThreadMessage = {
  externalId: string;
  effectKey: string;
  destination: ThreadDestination;
  kind: "post" | "react" | "code_view";
  body: unknown;
};

export class FakeThreadSurface implements ThreadSurface {
  readonly capabilities: ReadonlySet<ThreadCapability>;
  readonly messages: FakeThreadMessage[] = [];
  readonly calls: string[] = [];
  private failAfterSend = 0;

  constructor(
    readonly kind: ThreadSurfaceKind,
    capabilities: readonly ThreadCapability[] = ["post", "react"],
  ) {
    this.capabilities = new Set(capabilities);
  }

  loseNextAcknowledgement(): void {
    this.failAfterSend += 1;
  }

  async delivered(destination: ThreadDestination, effectKey: string): Promise<string | null> {
    this.calls.push(`delivered ${effectKey}`);
    return (
      this.messages.find(
        (message) =>
          message.effectKey === effectKey &&
          message.destination.channelId === destination.channelId &&
          message.destination.installationId === destination.installationId,
      )?.externalId ?? null
    );
  }

  async post(destination: ThreadDestination, input: { effectKey: string; text: string }) {
    return this.send(destination, input.effectKey, "post", input.text);
  }

  async react(
    destination: ThreadDestination,
    input: { effectKey: string; messageId: string; emoji: string },
  ) {
    return this.send(destination, input.effectKey, "react", input);
  }

  get showCodeView() {
    return this.capabilities.has("code_view")
      ? (destination: ThreadDestination, input: { effectKey: string; view: unknown }) =>
          Promise.resolve().then(() =>
            this.send(destination, input.effectKey, "code_view", input.view),
          )
      : undefined;
  }

  private send(
    destination: ThreadDestination,
    effectKey: string,
    kind: FakeThreadMessage["kind"],
    body: unknown,
  ): string {
    this.calls.push(`${kind} ${effectKey}`);
    const externalId = `${this.kind}-${this.messages.length + 1}`;
    this.messages.push({ externalId, effectKey, destination, kind, body });
    if (this.failAfterSend > 0) {
      this.failAfterSend -= 1;
      throw new Error("The surface did not acknowledge the message.");
    }
    return externalId;
  }
}
