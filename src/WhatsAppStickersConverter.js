/* global libwebp, WebAssembly */

import Jimp from 'jimp';
import JSZip from 'jszip';
import EventEmitter from 'events';

const isWebAssemblySupported = () => {
  try {
    if (typeof WebAssembly === 'object'
      && typeof WebAssembly.instantiate === 'function') {
      const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
      if (module instanceof WebAssembly.Module) return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
    }
  } catch (e) {
    return false;
  }
  return false;
};

class WhatsAppStickersConverter {
  module = null;

  api = null;

  init() {
    if (!isWebAssemblySupported()) {
      throw new Error('WebAssembly is not supported.');
    }

    return new Promise((resolve, reject) => {
      // in case wasm is not loaded
      setTimeout(() => reject(new Error('WebAssembly is not loaded.')), 2000);
      libwebp()
        .then((module) => {
          this.module = module;
          this.api = {
            version: module.cwrap('version', 'number', []),
            create_buffer: module.cwrap('create_buffer', 'number', ['number', 'number']),
            create_buffer_with_size: module.cwrap('create_buffer_with_size', 'number', ['number']),
            destroy_buffer: module.cwrap('destroy_buffer', '', ['number']),
            encode: module.cwrap('encode', '', ['number', 'number', 'number', 'number']),
            decode: module.cwrap('decode', 'number', ['number', 'number']),
            free_result: module.cwrap('free_result', '', ['number']),
            get_encode_result_pointer: module.cwrap('get_encode_result_pointer', 'number', []),
            get_encode_result_size: module.cwrap('get_encode_result_size', 'number', []),
            get_decode_result_pointer: module.cwrap('get_decode_result_pointer', 'number', []),
            get_decode_result_width: module.cwrap('get_decode_result_width', 'number', []),
            get_decode_result_height: module.cwrap('get_decode_result_height', 'number', []),
          };
          console.log(`WebAssembly libwebp loaded, api version: ${this.api.version()}`);
          resolve();
        });
    });
  }

  async unzip(data) {
    return JSZip.loadAsync(data).then(async (zip) => {
      const imagePaths = [];
      zip.forEach((relativePath) => {
        if (!relativePath.startsWith('__MACOSX') && (relativePath.endsWith('.png') || relativePath.endsWith('.jpg'))) {
          imagePaths.push(relativePath);
        }
      });
      if (imagePaths.length < 3) {
        throw new Error('Less than 3 images are found!');
      }
      return {
        trayFile: await zip.file(imagePaths[0]).async('blob'),
        stickersFiles: await Promise.all(imagePaths.map(path => zip.file(path).async('blob'))),
      };
    });
  }

  async processImageFile(file, type) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onloadend = async () => {
        try {
          if (type === 'tray') {
            resolve(await this.resizeAndConvert(reader.result, 96, false));
          } else if (type === 'stickers') {
            resolve(await this.resizeAndConvert(reader.result, 512, true));
          }
        } catch (e) {
          reject(e);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  convertImageDataToWebpURL(imageData, quality) {
    const p = this.api.create_buffer(imageData.width, imageData.height);
    this.module.HEAP8.set(imageData.data, p);
    this.api.encode(p, imageData.width, imageData.height, quality);
    const resultPointer = this.api.get_encode_result_pointer();
    const resultSize = this.api.get_encode_result_size();
    const resultView = new Uint8Array(this.module.HEAP8.buffer, resultPointer, resultSize);
    const result = new Uint8Array(resultView);
    this.api.free_result(resultPointer);
    this.api.destroy_buffer(p);
    return `data:image/webp;base64,${btoa(result.reduce((data, byte) => data + String.fromCharCode(byte), ''))}`;
  }

  convertWebpURLToPngURL(url) {
    const binaryString = atob(url.replace(/^data:image\/[a-z]+;base64,/, ''));
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const p = this.api.create_buffer_with_size(bytes.byteLength);
    this.module.HEAP8.set(bytes, p);
    this.api.decode(p, len);
    const resultPointer = this.api.get_decode_result_pointer();

    const width = this.api.get_decode_result_width();
    const height = this.api.get_decode_result_height();
    const resultSize = width * height * 4;
    const resultView = new Uint8Array(this.module.HEAP8.buffer, resultPointer, resultSize);
    const result = new Uint8ClampedArray(resultView);
    this.api.free_result(resultPointer);
    this.api.destroy_buffer(p);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const imageData = new ImageData(result, width, height);
    canvas.width = width;
    canvas.height = height;
    context.putImageData(imageData, 0, 0);

    return canvas.toDataURL('image/png');
  }


  static dataURLToCanvasContext(url) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const image = new Image();
      image.addEventListener('load', () => {
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(context);
      }, false);
      image.src = url;
    });
  }

  static async addNumberToTray(url, text) {
    const context = await WhatsAppStickersConverter.dataURLToCanvasContext(url);
    const { canvas } = context;

    context.save();

    // draw circle
    context.beginPath();
    context.arc(canvas.width - 0 - 16, canvas.height - 0 - 16, 16, 0, 2 * Math.PI);
    context.fillStyle = 'rgba(53, 67, 90, 0.85)';
    context.fill();

    context.restore();

    // draw number
    context.font = '30px helvetica';
    context.textAlign = 'center';
    context.fillStyle = '#f7f7f7';
    context.lineWidth = 2;
    context.fillText(`${text}`, canvas.width - 0 - 16, canvas.height - 0 - 6);
    return canvas.toDataURL('image/png');
  }

  resizeAndConvert(input, px, toWebp) {
    return Jimp.read(input).then((_image) => {
      const image = _image.contain(px, px);

      const b64Promise = image.getBase64Async(Jimp.MIME_PNG);

      if (toWebp) {
        return b64Promise.then(async (url) => {
          const context = await WhatsAppStickersConverter.dataURLToCanvasContext(url);
          const { canvas } = context;
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

          let quality = 1.0;

          const useChrome = false;

          let webpUrl;

          while (true) {
            if (useChrome) {
              webpUrl = canvas.toDataURL('image/webp', quality);
            } else {
              webpUrl = this.convertImageDataToWebpURL(imageData, Math.ceil(quality * 100));
            }

            const byteLength = atob(webpUrl.replace(/^data:image\/[a-z]+;base64,/, '')).length;

            if (byteLength <= 100000) {
              break;
            }
            quality -= 0.08;
            const errorMsg = `WebP size ${Math.ceil(byteLength / 1024)}kb exceeded 100kb`;
            if (quality <= 0.07) {
              throw new Error(`Error converting files, ${errorMsg}`);
            }
            console.error(`${errorMsg}, resizing with quality ${quality}`);
          }
          return webpUrl;
        });
      }
      return b64Promise;
    });
  }

  convertImagesToPacks(trayFile, stickersFiles) {
    const emitter = new EventEmitter();
    (async () => {
      try {
        const tray = await this.processImageFile(trayFile, 'tray');
        const stickersInPack = [];

        const numOfPacks = Math.ceil(stickersFiles.length / 30);

        for (let pack = 0; pack < numOfPacks; pack++) {
          stickersInPack.push([]);
        }

        const trays = await Promise.all(stickersInPack.map((pack, index) => (
          numOfPacks === 1 ? Promise.resolve(tray) : WhatsAppStickersConverter.addNumberToTray(tray, `${index + 1}`)
        )));

        for (let i = 0; i < stickersFiles.length; i++) {
          // eslint-disable-next-line no-await-in-loop
          const sticker = await this.processImageFile(stickersFiles[i], 'stickers');
          emitter.emit('stickerLoad');
          stickersInPack[Math.floor(i / 30)].push(sticker);
        }

        // balance stickers if the last pack has less than 3 images
        if (numOfPacks > 1 && stickersInPack[numOfPacks - 1].length < 3) {
          stickersInPack[numOfPacks - 1] = [
            ...stickersInPack[numOfPacks - 2].splice(-(3 - stickersInPack[numOfPacks - 1].length)),
            ...stickersInPack[numOfPacks - 1],
          ];
        }

        emitter.emit('load', { trays, stickersInPack });
      } catch (e) {
        emitter.emit('error', e);
      }
    })();
    return emitter;
  }
}

export default WhatsAppStickersConverter;
