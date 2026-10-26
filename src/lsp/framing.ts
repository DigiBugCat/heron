/**
 * LSP base protocol framing: each JSON message is preceded by a
 * `Content-Length: <bytes>` header and a blank line. Lengths count UTF-8
 * bytes, not characters.
 */

/** Messages larger than this are treated as a broken stream. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const HEADER_END = Buffer.from('\r\n\r\n');

/** Wraps a JSON message in its header, ready to write to the server. */
export function encodeMessage(json: string): Buffer {
	const body = Buffer.from(json, 'utf-8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export class FramingError extends Error {}

/**
 * Turns a byte stream from the server into complete JSON messages. Chunks
 * may split anywhere, including inside a header or a multi-byte character.
 */
export class MessageReader {
	private pending: Buffer = Buffer.alloc(0);

	/** Adds `chunk` and returns every message it completed, in order. */
	push(chunk: Buffer): string[] {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		const messages: string[] = [];
		for (;;) {
			const headerEnd = this.pending.indexOf(HEADER_END);
			if (headerEnd < 0) {
				if (this.pending.length > 8192) throw new FramingError('Language server sent a header without an end');
				return messages;
			}
			const length = contentLength(this.pending.toString('ascii', 0, headerEnd));
			const bodyStart = headerEnd + HEADER_END.length;
			if (this.pending.length < bodyStart + length) return messages;
			messages.push(this.pending.toString('utf-8', bodyStart, bodyStart + length));
			this.pending = this.pending.subarray(bodyStart + length);
		}
	}
}

/** Reads `Content-Length` from a header block; other headers are ignored. */
export function contentLength(header: string): number {
	for (const line of header.split('\r\n')) {
		const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
		if (!match) continue;
		const length = Number(match[1]);
		if (length > MAX_MESSAGE_BYTES) throw new FramingError(`Language server message too large (${length} bytes)`);
		return length;
	}
	throw new FramingError('Language server message has no Content-Length header');
}
