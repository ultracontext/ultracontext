import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

const WIDTH = 28;
const HEIGHT = 12;
const SCALE = 40.0;
const CAMERA_Z = 20.0;
const CHARS = "··..,,--::;;==!!**##$$@@";

const zBuffer = new Float32Array(WIDTH * HEIGHT);
const screenBuffer = new Uint8Array(WIDTH * HEIGHT);

const pointsData = [];
function addPoint(x, y, z, type) {
  pointsData.push(x, y, z, type);
}

function addLine(x1, y1, z1, x2, y2, z2) {
  const density = 15;
  for (let i = 0; i <= density; i++) {
    const t = i / density;
    addPoint(
      x1 + (x2 - x1) * t,
      y1 + (y2 - y1) * t,
      z1 + (z2 - z1) * t,
      0
    );
  }
}

addLine(-1.8, -1.2, 0, -1.8, 1.2, 0);
addLine(-1.8, 1.2, 0, -1.0, 1.2, 0);
addLine(-1.8, -1.2, 0, -1.0, -1.2, 0);

addLine(1.8, -1.2, 0, 1.8, 1.2, 0);
addLine(1.8, 1.2, 0, 1.0, 1.2, 0);
addLine(1.8, -1.2, 0, 1.0, -1.2, 0);

addPoint(0, 0, 0, 1);

const points = new Float32Array(pointsData);
const pointCount = points.length / 4;

function renderFrame(angle) {
  zBuffer.fill(-Infinity);
  screenBuffer.fill(32);

  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  for (let i = 0; i < pointCount; i++) {
    const idx = i * 4;
    const px = points[idx];
    const py = points[idx + 1];
    const pz = points[idx + 2];
    const ptype = points[idx + 3];

    const xRot = px * cosA - pz * sinA;
    const yRot = py;
    const zRot = px * sinA + pz * cosA;

    const zFinal = zRot - CAMERA_Z;
    const ooz = -1.0 / zFinal;

    const screenX = Math.floor(WIDTH / 2 + xRot * ooz * SCALE * 2.0);
    const screenY = Math.floor(HEIGHT / 2 - yRot * ooz * SCALE);

    if (screenX >= 0 && screenX < WIDTH && screenY >= 0 && screenY < HEIGHT) {
      const bufIdx = screenX + screenY * WIDTH;
      if (ooz > zBuffer[bufIdx]) {
        zBuffer[bufIdx] = ooz;
        if (ptype === 1) {
          screenBuffer[bufIdx] = 79;
        } else {
          let charIdx = Math.floor((zRot + 2.0) * 4.5);
          if (charIdx < 0) charIdx = 0;
          if (charIdx >= CHARS.length) charIdx = CHARS.length - 1;
          screenBuffer[bufIdx] = CHARS.charCodeAt(charIdx);
        }
      }
    }
  }

  const lines = [];
  for (let y = 0; y < HEIGHT; y++) {
    let row = "";
    const offset = y * WIDTH;
    for (let x = 0; x < WIDTH; x++) {
      row += String.fromCharCode(screenBuffer[offset + x]);
    }
    lines.push(row);
  }
  return lines;
}

const Spinner = ({
  color = "green",
  prefix = "",
  suffix = "",
  prefixColor = "white",
  suffixColor = "white",
  sideLines = [],
  sideGap = 0,
  sideColor = "white",
}) => {
  const [frameRows, setFrameRows] = useState(() => renderFrame(0));

  useEffect(() => {
    let angle = 0;
    const timer = setInterval(() => {
      angle += 0.05;
      setFrameRows(renderFrame(angle));
    }, 33);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    ...frameRows.map((row, index) =>
      React.createElement(
        Text,
        { key: `spinner-row-${index}` },
        prefix ? React.createElement(Text, { color: prefixColor }, prefix) : "",
        React.createElement(Text, { color }, row),
        sideLines.length > 0
          ? React.createElement(Text, { color: sideColor }, `${" ".repeat(Math.max(sideGap, 0))}${sideLines[index] ?? ""}`)
          : "",
        suffix ? React.createElement(Text, { color: suffixColor }, suffix) : ""
      )
    )
  );
};

export default Spinner;
