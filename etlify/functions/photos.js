// Fonction Netlify : gère l'upload et la liste des photos via Cloudinary
// Route: /.netlify/functions/photos

const CLOUD_NAME = 'xnw6fyno';
const API_KEY = '978312665268393';
const API_SECRET = 'oO1U3Ka5LihhCwi4hTKWS2DOWFw';
const FOLDER = 'cuisine_ipad/photos';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // ---- GET : lister les photos ----
  if (event.httpMethod === 'GET') {
    try {
      const auth = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
      const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/image?prefix=${encodeURIComponent(FOLDER)}/&max_results=100&type=upload`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Basic ${auth}` }
      });
      const data = await res.json();

      const photos = (data.resources || []).map(r =>
        `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/w_1600,q_auto,f_auto/${r.public_id}`
      );

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos })
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: e.message })
      };
    }
  }

  // ---- POST : uploader une photo ----
  if (event.httpMethod === 'POST') {
    try {
      const { image } = JSON.parse(event.body); // image = data URL base64 (data:image/jpeg;base64,...)

      const formData = new URLSearchParams();
      formData.append('file', image);
      formData.append('folder', FOLDER);

      // Signature pour upload authentifié
      const timestamp = Math.floor(Date.now() / 1000);
      const crypto = require('crypto');
      const paramsToSign = `folder=${FOLDER}&timestamp=${timestamp}${API_SECRET}`;
      const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

      formData.append('timestamp', timestamp);
      formData.append('api_key', API_KEY);
      formData.append('signature', signature);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });

      const data = await res.json();

      if (data.secure_url) {
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, url: data.secure_url })
        };
      } else {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: data })
        };
      }
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: e.message })
      };
    }
  }

  return { statusCode: 405, headers, body: 'Method not allowed' };
};
