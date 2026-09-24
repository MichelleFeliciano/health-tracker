/* Health Tracker — health-zip.js
 * Minimal, streaming ZIP reader for the Apple Health "Export All Health Data" zip.
 * Spec: docs/team/research/R-001-apple-health-export.md §6.3 A–B (Rev. 2, incl. RR-8
 * disk-number fields and 0xFFFF with a Zip64 locator), CRC per §6.3 step 8 / Z16.
 *
 * Never reads the whole file: only the tail (EOCD), the central directory, one local
 * header, and then the chosen entry in 1 MiB slices with Blob.slice().arrayBuffer()
 * (no fetch(): the page CSP is connect-src 'none'). Deflate goes through the browser's
 * DecompressionStream('deflate-raw'). Nothing here logs file contents.
 * Classic script; works in a page (window.HT) and in a Worker (self.HT).
 */
(function (HT) {
  'use strict';

  var err = HT.healthDates.importError;

  var SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50;
  var SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
  var MAX_TAIL = 65557;                 // 22-byte EOCD + max 65535-byte comment
  var MAX_CD_BYTES = 64 * 1024 * 1024;  // a Health export's directory is far smaller
  var SLICE = 1024 * 1024;

  var MSG = {
    notZip: 'This isn’t a valid zip file (or it was cut short). Try exporting from the Health app again.',
    split: 'Split zip archives aren’t supported. Export from the Health app again as one file.',
    damaged: 'The zip file looks damaged. Try exporting from the Health app again.',
    noXml: 'export.xml wasn’t found in this zip. Is this the Apple Health export?',
    encrypted: 'Encrypted zips aren’t supported.',
    deflate64: 'This zip uses Deflate64, which the browser can’t read. Unzip it on a computer and import export.xml.',
    noDecompress: 'This browser can’t unzip files. Unzip the export first (on iPhone: tap the zip in the Files app), then import the export.xml file inside the apple_health_export folder.',
    incomplete: 'The export is incomplete or damaged. Try exporting from the Health app again.',
    crc: 'The export failed its integrity check (it may be damaged). Try exporting from the Health app again.',
    tooBig: 'This zip is larger than this app can read.',
    cancelled: 'Import cancelled.'
  };

  // ---------- CRC-32 (reflected poly 0xEDB88320, init/final 0xFFFFFFFF; RFC 1952 §8) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  /** Update a running CRC register (start with 0xFFFFFFFF; finish with ^ 0xFFFFFFFF). */
  function crcUpdate(reg, bytes) {
    var c = reg, T = CRC_TABLE;
    for (var i = 0, n = bytes.length; i < n; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
  }
  function crc32(bytes) { return (crcUpdate(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0; }

  // ---------- little-endian readers ----------
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }
  function u64(dv, o) {
    var lo = dv.getUint32(o, true), hi = dv.getUint32(o + 4, true);
    if (hi >= 2097152) throw err('tooBig', MSG.tooBig); // beyond 2^53
    return lo + hi * 4294967296;
  }
  function readView(file, a, b) {
    return file.slice(a, b).arrayBuffer().then(function (buf) { return new DataView(buf); });
  }

  var utf8 = new TextDecoder('utf-8');
  function decodeName(dv, off, len) {
    return utf8.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, len));
  }

  /** True if this browser can inflate raw deflate data (Safari/iOS 16.4+, Chrome 103+, Firefox 113+). */
  function hasDeflateRaw() {
    try {
      if (typeof DecompressionStream !== 'function') return false;
      new DecompressionStream('deflate-raw'); // eslint-disable-line no-new
      return true;
    } catch (e) { return false; }
  }

  /**
   * Sniff a picked file: 'zip' | 'xml' | 'csv' | null. R-001 §6.3 A (zip / xml);
   * CSV = a Shortcut file (name ends .csv, or starts with the exact header).
   */
  function sniff(file) {
    return file.slice(0, 64).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      var name = String(file.name || '').toLowerCase();
      if ((b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) ||
          /\.zip$/.test(name)) return 'zip';
      var start = (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) ? 3 : 0;
      var head = utf8.decode(b.subarray(start));
      if (head.indexOf('<?xml') === 0) return 'xml';
      if (/\.csv$/.test(name) || head.indexOf('date,metric,') === 0) return 'csv';
      return null;
    });
  }

  function findEocd(dv, tailStart, size) {
    for (var p = size - 22; p >= tailStart; p--) {
      var o = p - tailStart;
      if (dv.getUint32(o, true) === SIG_EOCD && p + 22 + u16(dv, o + 20) === size) return p;
    }
    return -1;
  }

  /** Walk the Zip64 extra field (id 0x0001); only fields whose central value is all-ones are present. */
  function applyZip64Extra(e, dv, off, len) {
    var end = off + len;
    while (off + 4 <= end) {
      var id = u16(dv, off), sz = u16(dv, off + 2), q = off + 4;
      if (q + sz > end) break;
      if (id === 0x0001) {
        var lim = q + sz;
        if (e.uncomp === 0xFFFFFFFF && q + 8 <= lim) { e.uncomp = u64(dv, q); q += 8; }
        if (e.comp === 0xFFFFFFFF && q + 8 <= lim) { e.comp = u64(dv, q); q += 8; }
        if (e.localOffset === 0xFFFFFFFF && q + 8 <= lim) { e.localOffset = u64(dv, q); q += 8; }
        if (e.disk === 0xFFFF && q + 4 <= lim) { e.disk = u32(dv, q); q += 4; }
        break;
      }
      off = q + sz;
    }
  }

  /** Read the central directory; returns [{name, flags, method, crc, comp, uncomp, localOffset}]. */
  function listEntries(file) {
    var size = file.size;
    if (size < 22) return Promise.reject(err('notZip', MSG.notZip));
    var tailStart = Math.max(0, size - MAX_TAIL);
    var eocdPos, eocd = {};
    return readView(file, tailStart, size).then(function (tail) {
      eocdPos = findEocd(tail, tailStart, size);
      if (eocdPos < 0) throw err('notZip', MSG.notZip);
      var o = eocdPos - tailStart;
      eocd.disk = u16(tail, o + 4);
      eocd.cdDisk = u16(tail, o + 6);
      eocd.total = u16(tail, o + 10);
      eocd.cdSize = u32(tail, o + 12);
      eocd.cdOffset = u32(tail, o + 16);
      // Zip64: ALWAYS look for the locator (R-001 §6.3 B.2, Z18).
      if (eocdPos < 20) return null;
      return readView(file, eocdPos - 20, eocdPos);
    }).then(function (loc) {
      var hasZ64 = !!(loc && u32(loc, 0) === SIG_Z64_LOC);
      // Disk-number checks (RR-8). EOCD +4/+6 may be 0xFFFF only when a Zip64 locator exists.
      var okDisk = function (v) { return v === 0 || (hasZ64 && v === 0xFFFF); };
      if (!okDisk(eocd.disk) || !okDisk(eocd.cdDisk)) throw err('split', MSG.split);
      if (!hasZ64) return eocd;
      if (u32(loc, 4) !== 0) throw err('split', MSG.split);           // disk with the Zip64 EOCD
      var totalDisks = u32(loc, 16);
      if (totalDisks !== 0 && totalDisks !== 1) throw err('split', MSG.split); // 1 = normal single file
      var z64Off = u64(loc, 8);
      if (z64Off + 56 > size) throw err('damaged', MSG.damaged);
      return readView(file, z64Off, z64Off + 56).then(function (z) {
        if (u32(z, 0) !== SIG_Z64_EOCD) throw err('damaged', MSG.damaged);
        if (u32(z, 16) !== 0 || u32(z, 20) !== 0) throw err('split', MSG.split);
        return { total: u64(z, 32), cdSize: u64(z, 40), cdOffset: u64(z, 48) };
      });
    }).then(function (d) {
      if (d.cdOffset + d.cdSize > size) throw err('damaged', MSG.damaged);
      if (d.cdSize > MAX_CD_BYTES) throw err('tooBig', MSG.tooBig);
      return readView(file, d.cdOffset, d.cdOffset + d.cdSize);
    }).then(function (cd) {
      var out = [], p = 0, n = cd.byteLength;
      while (p + 46 <= n) {
        if (u32(cd, p) !== SIG_CEN) throw err('damaged', MSG.damaged);
        var nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
        if (p + 46 + nameLen + extraLen + commentLen > n) throw err('damaged', MSG.damaged);
        var e = {
          flags: u16(cd, p + 8), method: u16(cd, p + 10), crc: u32(cd, p + 16),
          comp: u32(cd, p + 20), uncomp: u32(cd, p + 24), disk: u16(cd, p + 34),
          localOffset: u32(cd, p + 42), name: decodeName(cd, p + 46, nameLen)
        };
        applyZip64Extra(e, cd, p + 46 + nameLen, extraLen);
        out.push(e);
        p += 46 + nameLen + extraLen + commentLen;
      }
      return out;
    });
  }

  /** R-001 §6.3 B.4: pick export.xml (skip __MACOSX/, ._ files, folders). */
  function chooseEntry(entries) {
    var usable = entries.filter(function (e) {
      var base = e.name.slice(e.name.lastIndexOf('/') + 1);
      return e.name.indexOf('__MACOSX/') !== 0 && base.indexOf('._') !== 0 && !/\/$/.test(e.name);
    });
    function base(e) { return e.name.slice(e.name.lastIndexOf('/') + 1); }
    var cands = usable.filter(function (e) { return base(e).toLowerCase() === 'export.xml'; });
    if (cands.length) {
      var exact = cands.filter(function (e) { return e.name === 'apple_health_export/export.xml'; });
      if (exact.length) return exact[0];
      return cands.slice().sort(function (a, b) { return a.name.length - b.name.length; })[0];
    }
    var xmls = usable.filter(function (e) {
      var l = e.name.toLowerCase();
      return /\.xml$/.test(l) && l.indexOf('cda') < 0;
    });
    if (!xmls.length) return null;
    return xmls.sort(function (a, b) { return b.uncomp - a.uncomp; })[0];
  }

  /** Locate export.xml and validate it (§6.3 B.1–B.6). Resolves the entry + dataStart. */
  function locateExport(file) {
    return listEntries(file).then(function (entries) {
      var e = chooseEntry(entries);
      if (!e) throw err('noXml', MSG.noXml);
      if (e.flags & 1) throw err('encrypted', MSG.encrypted);
      if (e.method === 9) throw err('deflate64', MSG.deflate64);
      if (e.method !== 0 && e.method !== 8) {
        throw err('method', 'This zip uses compression method ' + e.method + ', which isn’t supported. Unzip it on a computer and import export.xml.');
      }
      if (e.method === 8 && !hasDeflateRaw()) throw err('noDecompress', MSG.noDecompress);
      if (e.localOffset + 30 > file.size) throw err('damaged', MSG.damaged);
      return readView(file, e.localOffset, e.localOffset + 30).then(function (lh) {
        if (u32(lh, 0) !== SIG_LOC) throw err('damaged', MSG.damaged);
        // Local lengths for the offset; sizes/CRC always from the central directory (Z4).
        e.dataStart = e.localOffset + 30 + u16(lh, 26) + u16(lh, 28);
        if (e.dataStart + e.comp > file.size) throw err('incomplete', MSG.incomplete);
        e.entryCount = entries.length;
        return e;
      });
    });
  }

  /**
   * Stream bytes [start, end) of a file, optionally inflating, and hand each output chunk
   * to onChunk (may return a promise). opts: { method, expectBytes, expectCrc, onProgress(done,total),
   * isCancelled() }. Resolves { outBytes, crc } after the size (and CRC, when given) checks.
   */
  function streamRange(file, start, end, onChunk, opts) {
    opts = opts || {};
    var pos = start, total = end - start;
    var cancelled = function () { return !!(opts.isCancelled && opts.isCancelled()); };
    var src = new ReadableStream({
      pull: function (ctrl) {
        if (cancelled()) { ctrl.error(err('cancelled', MSG.cancelled)); return; }
        if (pos >= end) { ctrl.close(); return; }
        var n = Math.min(SLICE, end - pos);
        return file.slice(pos, pos + n).arrayBuffer().then(function (buf) {
          pos += n;
          if (opts.onProgress) opts.onProgress(pos - start, total);
          ctrl.enqueue(new Uint8Array(buf));
        });
      }
    });
    var out = src;
    if (opts.method === 8) {
      try { out = src.pipeThrough(new DecompressionStream('deflate-raw')); }
      catch (e) { return Promise.reject(err('noDecompress', MSG.noDecompress)); }
    }
    var reader = out.getReader();
    var reg = 0xFFFFFFFF, outBytes = 0, wantCrc = typeof opts.expectCrc === 'number';
    function loop() {
      if (cancelled()) { try { reader.cancel(); } catch (e) { /* ignore */ } return Promise.reject(err('cancelled', MSG.cancelled)); }
      return reader.read().then(function (r) {
        if (r.done) return null;
        outBytes += r.value.length;
        if (wantCrc) reg = crcUpdate(reg, r.value);
        return Promise.resolve(onChunk(r.value)).then(loop);
      });
    }
    return loop().then(function () {
      var crc = (reg ^ 0xFFFFFFFF) >>> 0;
      if (typeof opts.expectBytes === 'number' && outBytes !== opts.expectBytes) throw err('incomplete', MSG.incomplete);
      if (wantCrc && crc !== (opts.expectCrc >>> 0)) throw err('crc', MSG.crc);
      return { outBytes: outBytes, crc: crc };
    }, function (e) {
      if (e && e.code) throw e;
      // A TypeError from the decompressor means truncated/corrupt deflate data (Z10).
      throw err('incomplete', MSG.incomplete);
    });
  }

  /** Stream the chosen zip entry's uncompressed bytes (size + CRC checked at the end). */
  function streamEntry(file, entry, onChunk, opts) {
    opts = opts || {};
    return streamRange(file, entry.dataStart, entry.dataStart + entry.comp, onChunk, {
      method: entry.method, expectBytes: entry.uncomp,
      expectCrc: opts.checkCrc === false ? undefined : entry.crc,
      onProgress: opts.onProgress, isCancelled: opts.isCancelled
    });
  }

  /** Stream a plain (already unzipped) file. */
  function streamFile(file, onChunk, opts) {
    opts = opts || {};
    return streamRange(file, 0, file.size, onChunk, { onProgress: opts.onProgress, isCancelled: opts.isCancelled });
  }

  HT.healthZip = {
    MSG: MSG,
    crc32: crc32,
    crcUpdate: crcUpdate,
    hasDeflateRaw: hasDeflateRaw,
    sniff: sniff,
    listEntries: listEntries,
    chooseEntry: chooseEntry,
    locateExport: locateExport,
    streamEntry: streamEntry,
    streamFile: streamFile
  };
})(self.HT = self.HT || {});
