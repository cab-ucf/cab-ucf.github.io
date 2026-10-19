// irweb: WebSockets for sites behind the Service Worker, which cannot intercept
// them. sw.js puts this in every page. A same-host socket becomes one streaming
// GET (app -> page) and a POST per batch of sends (page -> app), both under
// x/<sid>/__irpo/ws/<id>; irpo bridges them to a real WebSocket on the app.
// Frames either way: u8 opcode (1 text, 2 binary, 8 close), u32 length, payload.
(() => {
  const m = location.pathname.match(/^(.*\/x\/[a-z0-9]+)\//), Native = self.WebSocket
  if (!m || !Native) return
  const pre = m[1], enc = new TextEncoder(), dec = new TextDecoder()
  const head = (op, n) => { const h = new Uint8Array(5); h[0] = op; new DataView(h.buffer).setUint32(1, n); return h }
  // frames off a stream, in a buffer grown by doubling: linear, however it arrives
  async function* frames(rd) {
    let buf = new Uint8Array(1 << 16), len = 0, at = 0
    for (;;) {
      for (let n; len - at >= 5 && len - at >= 5 + (n = new DataView(buf.buffer).getUint32(at + 1)); at += 5 + n)
        yield [buf[at], buf.slice(at + 5, at + 5 + n)]
      const { value, done } = await rd.read()
      if (done) return
      if (at) buf.copyWithin(0, at, len), len -= at, at = 0
      if (len + value.length > buf.length) { const t = new Uint8Array(2 * (len + value.length)); t.set(buf.subarray(0, len)); buf = t }
      buf.set(value, len); len += value.length
    }
  }
  class WS extends EventTarget {
    constructor(url, protocols) {
      const u = new URL(url, location.href)
      if (u.host !== location.host) return new Native(url, protocols)
      super()
      Object.assign(this, { url: u.href, readyState: 0, binaryType: 'blob', protocol: '', extensions: '', bufferedAmount: 0 })
      this.at = `${pre}/__irpo/ws/${crypto.randomUUID()}`
      this.out = []
      this.pump((u.pathname.startsWith(pre + '/') ? u.pathname.slice(pre.length) : u.pathname) + u.search)
    }
    emit(type, init) {
      if (type === 'close') this.readyState = 3
      const e = type === 'message' ? new MessageEvent(type, init) : type === 'close' ? new CloseEvent(type, init) : new Event(type)
      this.dispatchEvent(e); this['on' + type]?.(e)
    }
    async pump(path) {
      try {
        const r = await fetch(this.at + '?path=' + encodeURIComponent(path), { cache: 'no-store' })
        if (!r.ok) throw Error(r.status)
        this.readyState = 1; this.emit('open')
        for await (const [op, p] of frames(r.body.getReader())) {
          if (op === 8) return this.emit('close', { code: p.length > 1 ? p[0] << 8 | p[1] : 1005, reason: dec.decode(p.slice(2)), wasClean: true })
          this.emit('message', { data: op === 1 ? dec.decode(p) : this.binaryType === 'arraybuffer' ? p.buffer : new Blob([p]) })
        }
        this.emit('close', { code: 1006, wasClean: false })
      } catch { if (this.readyState < 3) { this.emit('error'); this.emit('close', { code: 1006, wasClean: false }) } }
    }
    // Sends queue while a POST is in flight and go out together, in order.
    async post(...parts) {
      this.out.push(...parts)
      if (this.busy) return
      this.busy = true
      while (this.out.length) await fetch(this.at, { method: 'POST', body: new Blob(this.out.splice(0)) }).catch(() => {})
      this.busy = false
    }
    send(d) {
      if (this.readyState === 0) throw new DOMException('still connecting', 'InvalidStateError')
      if (this.readyState !== 1) return
      const b = typeof d === 'string' ? enc.encode(d) : d
      this.post(head(typeof d === 'string' ? 1 : 2, b instanceof Blob ? b.size : b.byteLength), b)
    }
    close(code = 1000, reason = '') {
      if (this.readyState > 1) return
      this.readyState = 2
      const r = enc.encode(reason)
      this.post(head(8, 2 + r.length), new Uint8Array([code >> 8, code & 255]), r)
    }
  }
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) WS[k] = WS.prototype[k] = v
  self.WebSocket = WS
})()
