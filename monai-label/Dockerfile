# Copyright (c) MONAI Consortium
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

FROM nvidia/cuda:12.1.1-devel-ubuntu22.04
#FROM python:3.10-slim

RUN apt update -y && apt install -y openslide-tools build-essential python3-pip python3-dev python-is-python3 ffmpeg libsm6 libxext6 libxcb-xinerama0 libxcb1 wget git

WORKDIR /code

COPY ./monai-label/requirements.txt ./
#ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH":/usr/lib/x86_64-linux-gnu:"
ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH:"/usr/local/nvidia/lib64"

RUN pip install --upgrade pip setuptools wheel \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

# Install torch separately so its Docker layer is cached independently.
# If anything after this fails, torch won't be re-downloaded on retry.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.8.0 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt \
    -i https://pypi.tuna.tsinghua.edu.cn/simple
#RUN pip install emoji ddd-dataset
#RUN pip install "git+https://github.com/lvis-dataset/lvis-api.git"

#RUN mim install mmengine
#RUN mim install "mmcv>=2.0.0rc4,<2.2.0"
#RUN mim install mmdet

# Copy source code AFTER heavy downloads — changes here won't re-trigger wget
COPY ./monai-label/. ./

RUN rm -rf /usr/local/lib/python3.10/dist-packages/dicomweb_client/web.py

COPY ./monai-label/backup/web.py /usr/local/lib/python3.10/dist-packages/dicomweb_client/

ENV CUDA_VISIBLE_DEVICES=1
ENV PATH=$PATH":/code/monailabel/scripts"

ENV PYTHONPATH=/code:$PYTHONPATH
RUN python -m monailabel.main apps --download --name radiology --output /code/apps
EXPOSE 8002
CMD ["python", "-m", "monailabel.main", "start_server", "--app", "/code/apps/radiology", "--studies", "http://orthanc:8042/dicom-web", "--conf", "models", "segmentation", "--conf", "use_pretrained_model", "false", "-p", "8002"]
