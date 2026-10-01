// ONE WebGLRenderer, many previews.
//
// ── The constraint this exists for ──────────────────────────────────────────────
//
// A marketplace browse grid lazily mounts every card it scrolls past. A WebGL
// context per card runs straight into the browser's per-page cap — around 16 in
// Chrome — at which point it starts dropping the OLDEST contexts, and previews
// further up the page go black at random with no error anywhere. That is not a limit
// you can raise; it is one you design around.
//
// So: a single renderer on an offscreen canvas draws each visible rig in turn and
// blits the result into that card's own 2D canvas. Cards are cheap `<canvas>`
// elements with a 2D context, of which a page may have hundreds.
//
// ── ⚠️ `preserveDrawingBuffer: true` ───────────────────────────────────────────
//
// Reading a WebGL canvas back — `drawImage`, `toDataURL`, `getImageData` — returns
// blank unless either the read happens inside the same task as the draw or the
// drawing buffer is preserved. The blit here IS in the same task, so in principle it
// works without it; in practice the failure mode when it does not (every card blank,
// no error, only on some drivers) is expensive enough that the small cost of
// preserving is the better trade. SwiftShader in particular does not agree with
// hardware drivers about this.
//
// ── ⚠️ One drawing buffer, viewport-sliced, never resized per card ─────────────
//
// `setSize` reallocates the drawing buffer. Calling it once per card per frame is a
// reallocation storm. Instead the GL canvas is sized once to the LARGEST registered
// preview and each rig renders into a viewport anchored at the canvas's top-left
// corner, which the blit then reads as a plain `(0, 0, w, h)` source rectangle.
// GL's viewport origin is bottom-left, hence the `height - h`.

import * as THREE from "three";

import type { PedPreviewRig } from "./ped-preview";

export interface SharedPreviewRendererOptions {
	/** Upper bound on the shared drawing buffer, in device pixels. Default 1280x720. */
	maxWidth?: number;
	maxHeight?: number;
	/** Frames per second the loop aims for. Default 30. */
	maxFps?: number;
	/**
	 * How many previews may be drawn in ONE frame.
	 *
	 * The loop round-robins, so a grid with more visible previews than this still
	 * animates — each one just gets a turn less often, and its mixer is advanced by
	 * the real time since ITS last draw, so it plays at the right speed regardless.
	 */
	budgetPerFrame?: number;
	/** Device pixel ratio cap. Default `min(devicePixelRatio, 2)`. */
	pixelRatio?: number;
}

export interface PreviewHandle {
	/** Whether this preview should be drawn at all. Bind it to an IntersectionObserver. */
	setVisible(visible: boolean): void;
	/** Re-read the target canvas's CSS size. Call on a resize. */
	measure(): void;
	/** True once at least one frame has been blitted into the target canvas. */
	get hasDrawn(): boolean;
	/** Stop drawing this preview. Does NOT dispose the rig; its owner does that. */
	release(): void;
}

interface Registration {
	rig: PedPreviewRig;
	canvas: HTMLCanvasElement;
	context: CanvasRenderingContext2D | null;
	width: number;
	height: number;
	aspect: number;
	visible: boolean;
	released: boolean;
	drawn: boolean;
	lastDrawnAt: number;
}

function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SharedPreviewRenderer {
	readonly renderer: THREE.WebGLRenderer;

	private readonly registrations: Registration[] = [];
	private readonly options: Required<SharedPreviewRendererOptions>;
	private cursor = 0;
	private animationId: number | null = null;
	private lastFrameAt = 0;
	private bufferWidth = 0;
	private bufferHeight = 0;
	private disposed = false;
	/** Set when the context is lost, so the loop stops instead of throwing per frame. */
	private contextLost = false;

	constructor(options: SharedPreviewRendererOptions = {}) {
		const ratio =
			options.pixelRatio ??
			Math.min(typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1, 2);
		this.options = {
			maxWidth: options.maxWidth ?? 1280,
			maxHeight: options.maxHeight ?? 720,
			maxFps: options.maxFps ?? 30,
			budgetPerFrame: options.budgetPerFrame ?? 4,
			pixelRatio: ratio,
		};

		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			// Transparent so a card's own surface colour shows through the background.
			alpha: true,
			preserveDrawingBuffer: true,
			powerPreference: "low-power",
		});
		this.renderer.setClearColor(0x000000, 0);
		// Pixel ratio is applied by sizing the buffer explicitly below, so three must
		// not scale it a second time.
		this.renderer.setPixelRatio(1);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this.renderer.setScissorTest(true);

		canvas.addEventListener("webglcontextlost", this.onContextLost);
		canvas.addEventListener("webglcontextrestored", this.onContextRestored);
	}

	private onContextLost = (event: Event): void => {
		// Default behaviour is to never fire `restored`. Preventing it asks the
		// browser to try, and stops the loop from spinning on a dead context.
		event.preventDefault();
		this.contextLost = true;
	};

	private onContextRestored = (): void => {
		this.contextLost = false;
		this.bufferWidth = 0;
		this.bufferHeight = 0;
		this.resizeBuffer();
	};

	/** Draw `rig` into `canvas` whenever it is visible. */
	register(canvas: HTMLCanvasElement, rig: PedPreviewRig): PreviewHandle {
		const entry: Registration = {
			rig,
			canvas,
			context: canvas.getContext("2d"),
			width: 0,
			height: 0,
			aspect: 16 / 9,
			visible: true,
			released: false,
			drawn: false,
			lastDrawnAt: 0,
		};
		this.registrations.push(entry);
		this.measure(entry);
		this.resizeBuffer();
		this.start();

		return {
			setVisible: (visible: boolean) => {
				entry.visible = visible;
			},
			measure: () => {
				this.measure(entry);
				this.resizeBuffer();
			},
			get hasDrawn() {
				return entry.drawn;
			},
			release: () => {
				if (entry.released) return;
				entry.released = true;
				const index = this.registrations.indexOf(entry);
				if (index >= 0) this.registrations.splice(index, 1);
				this.resizeBuffer();
				if (this.registrations.length === 0) this.stop();
			},
		};
	}

	/** How many previews are registered. Exposed so a host can assert the cap holds. */
	get size(): number {
		return this.registrations.length;
	}

	private measure(entry: Registration): void {
		const rect = entry.canvas.getBoundingClientRect();
		const cssWidth = rect.width || entry.canvas.clientWidth || 320;
		const cssHeight = rect.height || entry.canvas.clientHeight || 180;
		const ratio = this.options.pixelRatio;
		// ⚠️ ONE scale factor for both axes.
		//
		// Clamping width and height independently against the two maxima changes the
		// backing store's ASPECT RATIO away from the CSS box's, and the browser then
		// stretches the blit to fit — a 420x760 portrait canvas came back 840x720 and
		// rendered a character on stilts. It never showed up on the 16:9 grid because
		// neither cap bit there, which is exactly why it is worth a guard rather than
		// a note.
		const wanted = { w: cssWidth * ratio, h: cssHeight * ratio };
		const scale = Math.min(
			1,
			this.options.maxWidth / wanted.w,
			this.options.maxHeight / wanted.h,
		);
		const width = Math.max(1, Math.round(wanted.w * scale));
		const height = Math.max(1, Math.round(wanted.h * scale));
		entry.width = width;
		entry.height = height;
		entry.aspect = width / height;
		// The target canvas's backing store matches the region it receives, so the
		// blit is 1:1 and the browser does no resampling.
		if (entry.canvas.width !== width) entry.canvas.width = width;
		if (entry.canvas.height !== height) entry.canvas.height = height;
	}

	private resizeBuffer(): void {
		let width = 1;
		let height = 1;
		for (const entry of this.registrations) {
			width = Math.max(width, entry.width);
			height = Math.max(height, entry.height);
		}
		if (width === this.bufferWidth && height === this.bufferHeight) return;
		this.bufferWidth = width;
		this.bufferHeight = height;
		this.renderer.setSize(width, height, false);
	}

	start(): void {
		if (this.disposed || this.animationId !== null) return;
		this.lastFrameAt = now();
		const loop = () => {
			if (this.disposed) return;
			this.animationId = requestAnimationFrame(loop);
			this.tick();
		};
		this.animationId = requestAnimationFrame(loop);
	}

	stop(): void {
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
	}

	/** One pass of the round-robin. Exposed so a test can drive it without rAF. */
	tick(): void {
		if (this.contextLost || this.registrations.length === 0) return;
		const t = now();
		const minInterval = 1000 / this.options.maxFps;
		if (t - this.lastFrameAt < minInterval - 1) return;
		this.lastFrameAt = t;

		let drawn = 0;
		// Walk at most one full lap, so a page where nothing is visible costs one
		// pass over the list rather than spinning on the budget.
		for (let i = 0; i < this.registrations.length && drawn < this.options.budgetPerFrame; i++) {
			const entry = this.registrations[(this.cursor + i) % this.registrations.length];
			if (!entry.visible || !entry.context || entry.released) continue;
			// A canvas whose element left the document still has a context and would
			// happily consume budget forever.
			if (!entry.canvas.isConnected) continue;
			this.draw(entry, t);
			drawn++;
		}
		this.cursor =
			this.registrations.length === 0 ? 0 : (this.cursor + drawn + 1) % this.registrations.length;
	}

	private draw(entry: Registration, t: number): void {
		const { rig, context } = entry;
		if (!context) return;

		// Real elapsed time for THIS preview, not the frame delta: with a budget the
		// same rig is not drawn every frame, and using the frame delta would play it
		// in slow motion proportional to how many previews share the page.
		const previous = entry.lastDrawnAt || t;
		// Clamped for the same reason `AnimViewerScene` clamps: a backgrounded tab
		// returns with a multi-second delta that would jump the clip instead of
		// resuming it.
		const delta = Math.min(Math.max(t - previous, 0) / 1000, 0.25);
		entry.lastDrawnAt = t;
		rig.update(delta);

		if (rig.camera.aspect !== entry.aspect) {
			rig.camera.aspect = entry.aspect;
			rig.reframe();
		}

		const x = 0;
		// GL's viewport origin is bottom-left; the blit reads from the top-left.
		const y = this.bufferHeight - entry.height;
		this.renderer.setViewport(x, y, entry.width, entry.height);
		this.renderer.setScissor(x, y, entry.width, entry.height);
		this.renderer.clear();
		this.renderer.render(rig.scene, rig.camera);

		context.clearRect(0, 0, entry.width, entry.height);
		context.drawImage(
			this.renderer.domElement,
			0,
			0,
			entry.width,
			entry.height,
			0,
			0,
			entry.width,
			entry.height,
		);
		entry.drawn = true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
		const canvas = this.renderer.domElement;
		canvas.removeEventListener("webglcontextlost", this.onContextLost);
		canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
		this.registrations.length = 0;
		this.renderer.dispose();
		this.renderer.forceContextLoss();
	}
}
