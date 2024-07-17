/*
  Source: https://github.com/fent/irc-colors.js/blob/master/lib/irc-colors.js
  ----

  MIT License

  Copyright (C) 2011 by fent

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/

const styleChars = {
  "\x0F": "normal",
  "\x1F": "underline",
  "\x02": "bold",
  "\x1D": "italic",
  "\x16": "inverse",
  "\x1E": "strikethrough",
  "\x11": "monospace",
};

// Coloring character.
const c = "\x03";

export const stripColors = (str: string) =>
  str.replace(/\x03\d{0,2}(,\d{0,2}|\x02\x02)?/g, "");

export const stripStyle = (str: string) => {
  let path: [string, number][] = [];
  for (let i = 0, len = str.length; i < len; i++) {
    let char = str[i];
    if (styleChars[char] || char === c) {
      let lastChar = path[path.length - 1];
      if (lastChar && lastChar[0] === char) {
        let p0 = lastChar[1];
        // Don't strip out styles with no characters inbetween.
        // And don't strip out color codes.
        if (i - p0 > 1 && char !== c) {
          str = str.slice(0, p0) + str.slice(p0 + 1, i) + str.slice(i + 1);
          i -= 2;
        }
        path.pop();
      } else {
        path.push([str[i], i]);
      }
    }
  }

  // Remove any unmatching style characterss.
  // Traverse list backwards to make removing less complicated.
  for (let char of path.reverse()) {
    if (char[0] !== c) {
      let pos = char[1];
      str = str.slice(0, pos) + str.slice(pos + 1);
    }
  }
  return str;
};

export const stripColorsAndStyle = (str: string) =>
  stripColors(stripStyle(str));
