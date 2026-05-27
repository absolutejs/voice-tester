// prism-media doesn't ship full types for the opus encoder/decoder. Augment
// with the subset we use so TS stops complaining without us pulling the whole
// repo. Mirrors the same stub in @absolutejs/meeting-discord.

declare module "prism-media" {
	import { Transform } from "node:stream";
	export namespace opus {
		export class Encoder extends Transform {
			constructor(options: { rate: number; channels: number; frameSize: number });
		}
		export class Decoder extends Transform {
			constructor(options: { rate: number; channels: number; frameSize: number });
		}
	}
}
