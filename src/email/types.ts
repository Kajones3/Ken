export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Same shape as providers/types.ts's Provider: one interface, swap the implementation. */
export interface EmailSender {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}
