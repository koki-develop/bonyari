/**
 * Which pixels of the view a near, opaque layer will paint over later in the
 * frame. Layers drawn before it (sky, ground, far ridges) skip those pixels:
 * whatever they would draw there is overwritten anyway.
 *
 * A layer may only mark pixels it writes fully opaquely (coverage exactly 1),
 * so skipping never changes the finished frame. Each mark records the layer's
 * place in the draw order, the lateral distance it is sorted by, so a layer
 * knows whether an occluder comes after it.
 */
export class Cover {
  width = 0;
  height = 0;
  /** Smallest draw-order distance (m) of the layers that overwrite each pixel; Infinity if none. */
  order = new Float32Array(0);
  /** Whether anything was marked this frame. */
  any = false;

  reset(width: number, height: number): void {
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.order = new Float32Array(width * height);
    }
    this.order.fill(Infinity);
    this.any = false;
  }

  /** Marks rows [y0, y1) of column x as overwritten by the layer drawn at `order`. */
  markRun(x: number, y0: number, y1: number, order: number): void {
    if (x < 0 || x >= this.width) {
      return;
    }
    const from = Math.max(0, y0);
    const to = Math.min(this.height, y1);
    const w = this.width;
    const o = this.order;
    for (let y = from; y < to; y++) {
      const i = y * w + x;
      if (order < o[i]) {
        o[i] = order;
      }
    }
    if (to > from) {
      this.any = true;
    }
  }

  /** Marks pixel (x, y) as overwritten by the layer drawn at `order`. */
  mark(x: number, y: number, order: number): void {
    this.markRun(x, y, y + 1, order);
  }
}
