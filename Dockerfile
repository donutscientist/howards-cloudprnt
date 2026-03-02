FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
  libcairo2-dev \
  libjpeg-dev \
  libpango1.0-dev \
  libgif-dev \
  librsvg2-dev

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node","server.cjs"]