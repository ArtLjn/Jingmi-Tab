/* ============================================================
   wallpaper.js —— 在线壁纸数据源
   来源：哲风壁纸 haowallpaper.com
   做法：站点是 Nuxt SSR，列表页里带 JSON-LD（ItemList），
        直接解析该结构化数据即可，无需逆向私有接口。
        缩略图：<id>_s320q80.webp（站点自带小图）
        大图：pre_cache_file/<id>.png（静态图公开预览约 1100px）
        注意：cache_file 通常只有约 890px，仅作为预览缺失时的降级；
        站内 4K/8K 原图走独立下载流程，不把预览图误标成原图。
   ============================================================ */
(function (global) {
  'use strict';

  var HOST = 'https://haowallpaper.com';
  var API = HOST + '/link';
  var PAGE_SIZE = 12;

  /* 站点公开客户端使用的响应解码参数（不是用户 Token）。 */
  var CODEC_KEY = '68zhehao2O776519';
  var CODEC_IV = 'aa176b7519e84710';
  var listCache = Object.create(null);

  /** 由原图地址推导缩略图地址 */
  function toThumb(url) {
    if (!url) return '';
    return url.replace(/\/([^/]+)\.(png|jpe?g|webp)$/i, '/$1_s320q80.webp');
  }

  /** 由原图地址推导站点公开的最大预览图（约 1100px） */
  function toLarge(url) {
    if (!url) return '';
    return url.replace('/cache_file/', '/pre_cache_file/');
  }

  /** 从 JSON-LD 里取出 itemListElement（兼容 mainEntity / @graph 两种嵌套） */
  function pickList(data) {
    if (!data) return null;
    if (Array.isArray(data.itemListElement)) return data.itemListElement;
    if (data.mainEntity && Array.isArray(data.mainEntity.itemListElement)) {
      return data.mainEntity.itemListElement;
    }
    if (Array.isArray(data['@graph'])) {
      for (var j = 0; j < data['@graph'].length; j++) {
        var got = pickList(data['@graph'][j]);
        if (got) return got;
      }
    }
    return null;
  }

  /** 从列表页 HTML 里解析 JSON-LD ItemList */
  function parseList(html) {
    var items = [];
    var seen = Object.create(null);
    if (!html) return items;

    var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var raw = m[1];
      if (raw.indexOf('itemListElement') === -1) continue;

      var data;
      try { data = JSON.parse(raw); } catch (e) { continue; }

      var arr = pickList(data);
      if (!arr) continue;

      for (var j = 0; j < arr.length; j++) {
        var el = arr[j];
        if (!el || !el.image) continue;
        if (seen[el.image]) continue;
        seen[el.image] = true;

        var idMatch = String(el.url || '').match(/(\d{6,})$/);
        items.push({
          provider: 'haowallpaper',
          id: idMatch ? idMatch[1] : String(items.length),
          title: String(el.name || '壁纸').replace(/「哲风壁纸」$/, ''),
          detail: el.url || '',
          image: el.image,
          thumb: toThumb(el.image),
          large: toLarge(el.image)
        });
      }
    }
    return items;
  }

  /**
   * 拉取一页壁纸
   * 注意：图床有防盗链，带外部 Referer 会返回 403，
   * 因此所有请求统一使用 no-referrer / credentials: omit。
   * @param {{query?:string, page?:number, fresh?:boolean}} opts
   */
  function listHao(opts) {
    opts = opts || {};
    var query = (opts.query || '').trim();
    var page = opts.page || 1;

    var url = HOST + '/homeView?page=' + page;
    if (query) url += '&search=' + encodeURIComponent(query);

    if (listCache[url] && !opts.fresh) return Promise.resolve(listCache[url]);

    return fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var items = parseList(html);
        if (!items.length) throw new Error('EMPTY');
        listCache[url] = items;
        return items;
      });
  }

  /* ------------------------- 官方原图接口 ------------------------- */

  function bytesFromBase64(text) {
    var raw = atob(text);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** 新版 hwa1：HKDF → AES-GCM → gzip，与站点公开客户端保持一致。 */
  function decodeV1(text) {
    var bytes = bytesFromBase64(text.slice(5));
    if (bytes.length < 33 || bytes[0] !== 1) throw new Error('DECODE_FAILED');
    var encoder = new TextEncoder();
    var additional = new Uint8Array(10);
    additional.set(encoder.encode('hwa1.'));
    additional.set(bytes.subarray(0, 5), 5);

    return crypto.subtle.importKey('raw', encoder.encode(CODEC_KEY), 'HKDF', false, ['deriveKey'])
      .then(function (baseKey) {
        return crypto.subtle.deriveKey({
          name: 'HKDF', hash: 'SHA-256',
          salt: encoder.encode('hao-web-response-hkdf-v1'),
          info: encoder.encode('hao-web-response-aes-gcm-v1')
        }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      })
      .then(function (key) {
        return crypto.subtle.decrypt({
          name: 'AES-GCM', tagLength: 128,
          iv: bytes.slice(5, 17), additionalData: additional
        }, key, bytes.slice(17));
      })
      .then(function (plain) {
        var stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      });
  }

  /** 旧版响应：AES-CBC + PKCS#7，WebCrypto 会自动去填充。 */
  function decodeLegacy(text) {
    var encoder = new TextEncoder();
    return crypto.subtle.importKey('raw', encoder.encode(CODEC_KEY), 'AES-CBC', false, ['decrypt'])
      .then(function (key) {
        return crypto.subtle.decrypt({
          name: 'AES-CBC', iv: encoder.encode(CODEC_IV)
        }, key, bytesFromBase64(text));
      })
      .then(function (plain) {
        return new TextDecoder().decode(plain).replace(/\0.*$/g, '');
      });
  }

  function decodeData(data) {
    if (typeof data !== 'string') return Promise.resolve(data);
    var text = data.trim();
    if (text.indexOf('hwd1:') === 0) return Promise.resolve(text.slice(5));
    if (text.indexOf('hwa1.') === 0) return decodeV1(text);
    if (/^https?:\/\//i.test(text) || /^[\[{"']/.test(text)) return Promise.resolve(text);
    return decodeLegacy(text);
  }

  /** 解码结果可能是 URL、JSON 字符串，或包了一层 data/url 的对象。 */
  function extractUrl(data) {
    if (!data) throw new Error('EMPTY_ORIGINAL_URL');
    if (typeof data === 'string') {
      var text = data.trim();
      if (/^https?:\/\//i.test(text)) return text;
      try { return extractUrl(JSON.parse(text)); } catch (e) {
        throw new Error('INVALID_ORIGINAL_URL');
      }
    }
    if (typeof data === 'object') {
      var keys = ['url', 'completeUrl', 'downloadUrl', 'fileUrl', 'data'];
      for (var i = 0; i < keys.length; i++) {
        if (data[keys[i]]) {
          try { return extractUrl(data[keys[i]]); } catch (e) {}
        }
      }
    }
    throw new Error('INVALID_ORIGINAL_URL');
  }

  function requestOriginalUrl(item, token) {
    var url = API + '/common/file/getCompleteUrl/' + encodeURIComponent(item.id);
    return fetch(url, {
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache', 'token': token }
    }).then(function (res) {
      return res.json().catch(function () { throw new Error('HTTP ' + res.status); })
        .then(function (payload) {
          if (!res.ok || Number(payload.status) !== 200) {
            var err = new Error(res.status === 401 || Number(payload.status) === 401
              ? 'AUTH_REQUIRED'
              : String(payload.msg || ('HTTP ' + res.status)));
            err.status = res.status;
            throw err;
          }
          return decodeData(payload.data);
        });
    }).then(extractUrl);
  }

  function fetchBlob(url) {
    return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (res) {
        if (res.status !== 200) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        if (!blob || !blob.size) throw new Error('EMPTY_BLOB');
        if (/text\/html|application\/json|application\/xml/i.test(blob.type)) {
          throw new Error('INVALID_IMAGE_RESPONSE');
        }
        return blob;
      });
  }

  /** 原图接口对动态壁纸可能返回 MP4；只接受浏览器可解码的静态图片。 */
  function validateOriginal(blob, url) {
    if (typeof createImageBitmap !== 'function') {
      if (!/^image\//i.test(blob.type)) return Promise.reject(new Error('NOT_STATIC_IMAGE'));
      return Promise.resolve({ blob: blob, url: url, original: true });
    }
    return createImageBitmap(blob).then(function (bmp) {
      var got = {
        blob: blob, url: url, original: true,
        width: bmp.width, height: bmp.height
      };
      bmp.close && bmp.close();
      return got;
    }).catch(function () { throw new Error('NOT_STATIC_IMAGE'); });
  }

  function fetchOriginal(item, token) {
    return requestOriginalUrl(item, token)
      .catch(function (err) {
        err.originalStage = '接口';
        throw err;
      })
      .then(function (url) {
        return fetchBlob(url)
          .then(function (blob) { return validateOriginal(blob, url); })
          .catch(function (err) {
            err.originalStage = '下载';
            try { err.originalHost = new URL(url).host; } catch (e) {}
            throw err;
          });
      });
  }

  /** 下载公开预览（依次尝试 pre_cache_file → cache_file）。 */
  function fetchPreview(item) {
    var candidates = [item.large, item.image].filter(Boolean);
    var tried = 0;

    function attempt() {
      if (tried >= candidates.length) return Promise.reject(new Error('IMAGE_FAILED'));
      var url = candidates[tried++];
      return fetchBlob(url)
        .then(function (blob) {
          return { blob: blob, url: url, original: false };
        })
        .catch(function () { return attempt(); });
    }
    return attempt();
  }

  /**
   * 原图优先、公开预览兜底。
   * Token 只用于本次官方请求，不写日志、不放进 URL、不进入缓存元数据。
   */
  function fetchHaoImage(item, opts) {
    var token = opts && String(opts.token || '').trim();
    if (!token) return fetchPreview(item);
    return fetchOriginal(item, token).catch(function (originalError) {
      return fetchPreview(item).then(function (got) {
        var raw = originalError && (originalError.message || originalError.name);
        // 错误可用于本地诊断，但不能回显 Token 或带签名的完整 URL。
        got.originalError = String(raw || 'ORIGINAL_FAILED')
          .split(token).join('[隐藏]')
          .replace(/https?:\/\/\S+/gi, '[地址]')
          .slice(0, 120);
        got.originalStage = originalError && originalError.originalStage || '';
        got.originalHost = originalError && originalError.originalHost || '';
        return got;
      });
    });
  }

  /** 从哲风 userData Cookie 中提取登录 Token，兼容 URL 编码与双重 JSON。 */
  function tokenFromUserData(value) {
    var text = String(value || '').trim();
    for (var i = 0; i < 4 && text; i++) {
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {}
      if (parsed && typeof parsed === 'object') {
        return parsed.token ? String(parsed.token) : '';
      }
      if (typeof parsed === 'string') {
        text = parsed;
        continue;
      }
      try {
        var decoded = decodeURIComponent(text);
        if (decoded === text) break;
        text = decoded;
      } catch (e) { break; }
    }
    return '';
  }

  function sourceList(options) {
    if (options && ['wallpic', 'tenwallpaper'].indexOf(options.provider) >= 0) return ChineseWallpapers.list(options);
    if (options && ['pexels', 'unsplash'].indexOf(options.provider) >= 0) return PhotoWallpapers.list(options);
    if (options && options.provider === 'pixabay') return PixabayWallpapers.list(options);
    if (options && options.provider === 'haowallpaper') return listHao(options);
    if (options && ['wallpapercave', 'bing'].indexOf(options.provider) >= 0) return OtherWallpapers.list(options);
    return UhdWallpaper.list(options);
  }
  function list(options) {
    options = options || {};
    if (!options.provider || ['all', 'domestic', 'wallpic', 'tenwallpaper', 'uhdpaper', 'wallpapercave'].indexOf(options.provider) >= 0) return WallpaperSearch.list(options, sourceList);
    return sourceList(options);
  }
  function resolveImage(item, options) {
    if (['wallpic', 'tenwallpaper'].indexOf(item.provider) >= 0) return ChineseWallpapers.resolveImage(item);
    if (['pexels', 'unsplash'].indexOf(item.provider) >= 0) return PhotoWallpapers.resolveImage(item, options);
    if (item.provider === 'pixabay') return PixabayWallpapers.resolveImage(item);
    if (item.provider === 'uhdpaper') return UhdWallpaper.resolveImage(item);
    if (['wallpapercave', 'bing'].indexOf(item.provider) >= 0) return OtherWallpapers.resolveImage(item);
    var token = options && String(options.token || '').trim();
    async function preview(error) {
      for (var url of [item.large, item.image].filter(Boolean)) {
        try { return Object.assign(await UhdWallpaper.probeImage(url), { original: false, originalError: error && error.message || '' }); } catch (e) { /* 继续尝试另一张预览。 */ }
      }
      throw new Error('IMAGE_FAILED');
    }
    if (!token) return preview();
    return requestOriginalUrl(item, token).then(function (url) {
      return UhdWallpaper.probeImage(url).then(function (result) { return Object.assign(result, { original: true }); });
    }).catch(preview);
  }
  function fetchImage(item, options) {
    if (options && options.resolved) {
      var result = options.resolved;
      return fetchBlob(result.url).then(function (blob) { return validateOriginal(blob, result.url); }).then(function (got) {
        /* 哲风与 Pixabay 的清晰度门槛由各自 resolveImage 负责（Pixabay 接口给不到 4K 时才用高清）。 */
        if (['haowallpaper', 'pixabay'].indexOf(item.provider) < 0
          && (!got.width || !got.height || got.width < 3840 || got.height < 2160)) throw new Error('UHD_LOW_RESOLUTION');
        got.original = !!result.original; return got;
      });
    }
    if (item.provider === 'uhdpaper') return UhdWallpaper.fetchImage(item);
    if (['wallpic', 'tenwallpaper', 'wallpapercave', 'bing', 'pexels', 'unsplash', 'pixabay'].indexOf(item.provider) >= 0) return resolveImage(item, options).then(function (result) { return fetchImage(item, { resolved: result }); });
    return fetchHaoImage(item, options);
  }
  global.WallpaperSource = {
    list: list,
    fetchImage: fetchImage,
    resolveImage: resolveImage,
    parseList: parseList,
    tokenFromUserData: tokenFromUserData,
    toThumb: toThumb,
    pageSize: PAGE_SIZE,
    host: HOST
  };
})(window);
