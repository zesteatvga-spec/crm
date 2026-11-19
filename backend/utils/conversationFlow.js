const Contact      = require('../models/Contact');
const Template     = require('../models/Template');
const { sendMetaTemplate } = require('./whatsappService');
const { uploadMediaForSending } = require('./metaTemplateService');
const path = require('path');
const mime = require('mime-types');
const fs = require('fs');

const digits = (phone) => String(phone).replace(/\D/g, '');

const toSendPhone = (phone) => {
  const d = digits(phone);
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  return d.slice(-10);
};

const toDbPhone = (phone) => toSendPhone(phone);

// ── Meta Template start ───────────────────────────────────────────────────────
const startMetaTemplate = async (phone, template, options = {}) => {
  const sp = toSendPhone(phone);

  const contact = await Contact.findOne({ phone: sp });
  if (contact?.optedOut) { console.log(`⛔ Skipping opted-out: ${sp}`); return; }

  const name  = contact?.name  || 'Customer';
  const isAuthentication = String(template.category || '').toUpperCase() === 'AUTHENTICATION';
  // AUTHENTICATION templates carry a one-time code, supplied per recipient by
  // the caller. It must be the same value in the body and in the copy-code
  // button, otherwise the button copies nothing (or the wrong string).
  const otpCode = String(options.otpCode || '').trim();

  if (isAuthentication) {
    if (!otpCode) {
      const err = new Error(
        'This is an AUTHENTICATION template — the one-time code must be provided before sending.'
      );
      err.status = 400;
      throw err;
    }
    if (!/^\S{4,10}$/.test(otpCode)) {
      const err = new Error('The one-time code must be 4-10 characters with no spaces.');
      err.status = 400;
      throw err;
    }
  }
  
  // Construct components for Meta API
  const components = [];

  // Check if template has an Image/Video/Document header
  const headerComponent = template.components?.find(c => c.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format));
  
  if (headerComponent) {
    let mediaId = template.mediaId;
    let mediaLink = null;

    // 1. If template has a direct public URL in imageUrl or in example header_handle
    const handleUrl = headerComponent.example?.header_handle?.[0];
    if (typeof template.imageUrl === 'string' && template.imageUrl.startsWith('http')) {
      mediaLink = template.imageUrl;
    } else if (typeof handleUrl === 'string' && handleUrl.startsWith('http')) {
      mediaLink = handleUrl;
    }

    // 2. If it's a local file and we have no mediaId or mediaLink, try uploading or using public server URL
    if (!mediaId && !mediaLink && template.imageUrl) {
      let localPath = template.imageUrl;
      if (localPath.startsWith('/uploads/')) {
        let absolutePath = path.join(__dirname, '..', localPath);
        if (!fs.existsSync(absolutePath)) {
          absolutePath = path.join(__dirname, '..', localPath.replace('/uploads/', '/uploads/campaigns/'));
        }
        if (fs.existsSync(absolutePath)) {
          try {
            console.log(`Uploading local media to Meta to get Media ID...`);
            mediaId = await uploadMediaForSending(absolutePath, mime.lookup(absolutePath) || 'image/jpeg');
            if (mediaId) {
              await Template.findByIdAndUpdate(template._id, { mediaId });
            }
          } catch (e) {
            console.error('Failed to upload local media:', e.message);
          }
        }
      }
      if (!mediaId && template.imageUrl.startsWith('/uploads/')) {
        const baseHost = process.env.RENDER_EXTERNAL_URL || 'https://crm-1-62pl.onrender.com';
        mediaLink = `${baseHost}${template.imageUrl}`;
      }
    }

    // 3. Fallback: ensure a valid image link is always provided so Meta doesn't fail with format mismatch
    if (!mediaId && !mediaLink) {
      if (handleUrl && handleUrl.startsWith('http')) {
        mediaLink = handleUrl;
      } else {
        mediaLink = 'https://images.unsplash.com/photo-1544025162-d76694265947?w=800';
      }
    }

    const mediaType = headerComponent.format.toLowerCase();
    const mediaParam = {};
    if (mediaId) {
      mediaParam[mediaType] = { id: mediaId };
    } else if (mediaLink) {
      mediaParam[mediaType] = { link: mediaLink };
    }

    components.push({
      type: 'header',
      parameters: [
        {
          type: mediaType,
          ...mediaParam
        }
      ]
    });
  }

  // Check if template body has variables ({{1}})
  const bodyComponent = template.components?.find(c => c.type === 'BODY');
  if (isAuthentication) {
    // Meta's authentication template takes exactly one body parameter: the code.
    components.push({
      type: 'body',
      parameters: [
        { type: 'text', text: otpCode }
      ]
    });
    // The OTP button (COPY_CODE / ONE_TAP / ZERO_TAP) is addressed as index 0 and
    // receives the same code as a button parameter.
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [
        { type: 'text', text: otpCode }
      ]
    });
  } else if (bodyComponent && bodyComponent.text && bodyComponent.text.includes('{{1}}')) {
    components.push({
      type: 'body',
      parameters: [
        { type: 'text', text: name }
      ]
    });
  }

  try {
    // The category lets whatsappService route MARKETING templates through the
    // Marketing Messages API (/marketing_messages) instead of /messages.
    return await sendMetaTemplate(sp, template.name, template.language, components, {
      category: template.category,
    });
  } catch (e) {
    console.log(`❌ Failed to send Meta Template to ${sp}:`, e.message);
    throw e;
  }
};

module.exports = {
  ConversationFlow: { startMetaTemplate }
};