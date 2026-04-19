import fs from 'fs';
import path from 'path';

const variablesPath = './src/styles/variables.css';
const rootDir = './src';
const reportDir = './report';
const reportFile = `${reportDir}/unmatched-values.txt`;

// ensure report folder exists
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir);
}

// Read variables file
const variablesContent = fs.readFileSync(variablesPath, 'utf8');

// Build value → variable map
const valueMap = {};

variablesContent.replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, name, value) => {
  valueMap[value.trim()] = name;
});

// console.log('Value Map:', valueMap); 

// Get all css/scss files
const getFiles = dir =>
  fs.readdirSync(dir).flatMap(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      return getFiles(filePath);
    }

    if (
      (filePath.endsWith('.css') || filePath.endsWith('.scss')) &&
      path.basename(filePath) !== 'variables.css'
    ) {
      return [filePath];
    }

    return [];
  });

const files = getFiles(rootDir);

// Track unmatched values
const unmatchedMap = new Map();

// Process files
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  let updated = content
    .split('\n')
    .map((line, index) => {
      if (!line.includes(':')) return line;

      let newLine = line;
      let matched = false;

      Object.entries(valueMap).forEach(([value, name]) => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const regex = new RegExp(
          `(?<![\\w-])${escaped}(?![\\w-])`,
          'g'
        );

        if (regex.test(newLine)) {
          matched = true;
          newLine = newLine.replace(regex, `var(--${name})`);
        }
      });

      // log unmatched
      if (!matched) {
        const parts = newLine.split(':');
        if (parts[1]) {
          const valuePart = parts[1].replace(';', '').trim();

          if (valuePart && !valuePart.includes('var(')) {
            if (!unmatchedMap.has(valuePart)) {
              unmatchedMap.set(valuePart, []);
            }

            unmatchedMap.get(valuePart).push({
              file,
              line: index + 1
            });
          }
        }
      }

      return newLine;
    })
    .join('\n');

  if (updated !== content) {
    fs.writeFileSync(file, updated, 'utf8');
    console.log('Updated:', file);
  }
});

// Write report
let output = '';
unmatchedMap.forEach((entries, value) => {
  const totalOccurrences = entries.length;
  output += `\nValue: ${value} (${totalOccurrences} occurrences)\n`;
  output += '----------------------------------------\n';

  // group by file
  const fileMap = {};

  entries.forEach(({ file, line }) => {
    if (!fileMap[file]) fileMap[file] = [];
    fileMap[file].push(line);
  });

  Object.entries(fileMap).forEach(([file, lines]) => {
    output += ` File: ${file} | Line: ${lines.join(', ')}\n`;
  });
});

fs.writeFileSync(reportFile, output, 'utf8');
console.log('\nFormatted report generated at:', reportFile);