import fs from 'fs';
import path from 'path';

const rootDir = './src';
const reportDir = './report';
const reportFile = `${reportDir}/important-report.txt`;

// ensure report folder exists
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir);
}

// Get all CSS/SCSS files
const getFiles = dir =>
  fs.readdirSync(dir).flatMap(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      return getFiles(filePath);
    }

    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) {
      return [filePath];
    }

    return [];
  });

const files = getFiles(rootDir);

// Collect !important usages
const importantMap = new Map();

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');

  content.split('\n').forEach((line, index) => {
    if (!line.includes('!important')) return;

    const property = line.split(':')[0]?.trim();
    const value = line.split(':')[1]?.trim();

    // basic classification
    let type = 'override';

    if (/(width|height|margin|padding|position|top|left|right|bottom)/i.test(property)) {
      type = 'layout';
    } else if (/(color|background|font)/i.test(property)) {
      type = 'utility';
    }

    const key = `${property} | ${value}`;

    if (!importantMap.has(key)) {
      importantMap.set(key, []);
    }

    importantMap.get(key).push({
      file,
      line: index + 1,
      type
    });
  });
});

// Generate report
if (importantMap.size > 0) {
  let output = 'IMPORTANT USAGE REPORT\n';
  output += '========================================\n';

  importantMap.forEach((entries, key) => {
    const [property, value] = key.split('|').map(s => s.trim());
    const count = entries.length;
    const type = entries[0].type;

    output += `\nProperty: ${property}\n`;
    output += `Value: ${value}\n`;
    output += `Type: ${type}\n`;
    output += `Occurrences: ${count}\n`;

    // group by file
    const fileMap = {};

    entries.forEach(({ file, line }) => {
      if (!fileMap[file]) fileMap[file] = [];
      fileMap[file].push(line);
    });

    Object.entries(fileMap).forEach(([file, lines]) => {
      output += `File: ${file} : ${lines.join(', ')}\n`;
    });
    output += '----------------------------------------\n';
  });

  fs.writeFileSync(reportFile, output, 'utf8');
  console.log('\nImportant report generated at:', reportFile);
} else {
  console.log('\nNo !important usage found');
}