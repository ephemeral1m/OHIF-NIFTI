import axios from 'axios';

function payloadByteLength(data) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
}

function summarizeResponse(response) {
  return {
    status: response?.status,
    method: response?.config?.method,
    contentType: response?.headers?.['content-type'],
    dataType: response?.data?.constructor?.name,
    byteLength: payloadByteLength(response?.data),
  };
}

function summarizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: String(error?.message || 'Unknown error').slice(0, 240),
    status: error?.response?.status,
    method: error?.config?.method,
    responseByteLength: payloadByteLength(error?.response?.data),
  };
}

function requestPath(url) {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return 'unknown';
  }
}

export default class MonaiLabelClient {
  constructor(server_url) {
    this.server_url = new URL(server_url);
  }

  async info() {
    let url = new URL('info/', this.server_url);
    return await MonaiLabelClient.api_get(url.toString());
  }

  async segmentation(model, image, params = {}, label = null) {
    // label is used to send label volumes, e.g. scribbles,
    // that are to be used during segmentation
    return this.infer(model, image, params, label);
  }

  async deepgrow(model, image, foreground, background, params = {}) {
    params['foreground'] = foreground;
    params['background'] = background;
    return this.infer(model, image, params);
  }

  async infer(model, image, params, label = null, result_extension = '.nii.gz') {
    let url = new URL('infer/' + encodeURIComponent(model), this.server_url);
    url.searchParams.append('image', image);
    url.searchParams.append('output', 'dicom_seg');
    // url.searchParams.append('output', 'image');
    url = url.toString();

    if (result_extension) {
      params.result_extension = result_extension;
      params.result_dtype = 'uint16';
      params.result_compress = false;
      params.studyInstanceUID = new URLSearchParams(window.location.search).get(
        'StudyInstanceUIDs'
      );
    }

    // return the indexes as defined in the config file
    params.restore_label_idx = false;

    return await MonaiLabelClient.api_post(url, params, label, true, 'arraybuffer');
  }

  async next_sample(stategy = 'random', params = {}) {
    const url = new URL(
      'activelearning/' + encodeURIComponent(stategy),
      this.server_url
    ).toString();

    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async save_label(image, label, params) {
    let url = new URL('datastore/label', this.server_url);
    url.searchParams.append('image', image);
    url = url.toString();

    /* debugger; */

    const data = MonaiLabelClient.constructFormDataFromArray(params, label, 'label', 'label.bin');

    return await MonaiLabelClient.api_put_data(url, data, 'json');
  }

  async is_train_running() {
    let url = new URL('train/', this.server_url);
    url.searchParams.append('check_if_running', 'true');
    url = url.toString();

    const response = await MonaiLabelClient.api_get(url);
    return response && response.status === 200 && response.data.status === 'RUNNING';
  }

  async run_train(params) {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async stop_train() {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_delete(url);
  }

  static constructFormDataFromArray(params, data, name, fileName) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append(name, data, fileName);
    return formData;
  }

  static constructFormData(params, files) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));

    if (files) {
      if (!Array.isArray(files)) {
        files = [files];
      }
      for (let i = 0; i < files.length; i++) {
        formData.append(files[i].name, files[i].data, files[i].fileName);
      }
    }
    return formData;
  }

  static constructFormOrJsonData(params, files) {
    return files ? MonaiLabelClient.constructFormData(params, files) : params;
  }

  static api_get(url) {
    console.debug('MONAI GET:', requestPath(url));
    return axios
      .get(url)
      .then(function (response) {
        console.debug('MONAI GET response:', summarizeResponse(response));
        return response;
      })
      .catch(function (error) {
        console.warn('MONAI GET failed:', summarizeError(error));
        return error;
      })
      .finally(function () {});
  }

  static api_delete(url) {
    console.debug('MONAI DELETE:', requestPath(url));
    return axios
      .delete(url)
      .then(function (response) {
        console.debug('MONAI DELETE response:', summarizeResponse(response));
        return response;
      })
      .catch(function (error) {
        console.warn('MONAI DELETE failed:', summarizeError(error));
        return error;
      })
      .finally(function () {});
  }

  static api_post(url, params, files, form = true, responseType = 'arraybuffer') {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_post_data(url, data, responseType);
  }

  static api_post_data(url, data, responseType) {
    console.debug('MONAI POST:', requestPath(url));
    return axios
      .post(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug('MONAI POST response:', summarizeResponse(response));
        return response;
      })
      .catch(function (error) {
        console.warn('MONAI POST failed:', summarizeError(error));
        return error;
      })
      .finally(function () {});
  }

  static api_put(url, params, files, form = false, responseType = 'json') {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_put_data(url, data, responseType);
  }

  static api_put_data(url, data, responseType = 'json') {
    console.debug('MONAI PUT:', requestPath(url));
    return axios
      .put(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug('MONAI PUT response:', summarizeResponse(response));
        return response;
      })
      .catch(function (error) {
        console.warn('MONAI PUT failed:', summarizeError(error));
        return error;
      });
  }
}
