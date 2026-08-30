#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const changedFiles = process.env.CHANGED_FILES?.split('\n').filter(Boolean) || [];
const issues = [];

// Review rules
const rules = {
  checkConsoleLog: (file, content) => {
    const pattern = /console\.(log|debug|warn|info)\(/g;
    const matches = [...content.matchAll(pattern)];
    return matches.map(m => ({
      message: `Remove console.${m[1]}() before production`,
      severity: 'warning',
      line: content.substring(0, m.index).split('\n').length
    }));
  },

  checkUnusedImports: (file, content) => {
    if (!file.endsWith('.jsx') && !file.endsWith('.js')) return [];
    const importPattern = /import\s+(?:{[^}]+}|.*?)\s+from\s+['"](.+?)['"]/g;
    const imports = [...content.matchAll(importPattern)];
    const report = [];
    
    imports.forEach(match => {
      const imported = match[0].match(/import\s+(?:{([^}]+)}|(\w+))/);
      if (imported) {
        const names = imported[1] ? imported[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop()) : [imported[2]];
        names.forEach(name => {
          if (!new RegExp(`\\b${name}\\b`).test(content.replace(match[0], ''))) {
            report.push({
              message: `Unused import: ${name}`,
              severity: 'info',
              line: content.substring(0, match.index).split('\n').length
            });
          }
        });
      }
    });
    return report;
  },

  checkArrowFunctions: (file, content) => {
    const innerFunctionPattern = /function\s+\w+\s*\(/g;
    const matches = [...content.matchAll(innerFunctionPattern)];
    if (matches.length > 0) {
      return [{
        message: 'Prefer arrow functions over function declarations',
        severity: 'info'
      }];
    }
    return [];
  },

  checkPropTypes: (file, content) => {
    if (!file.endsWith('.jsx')) return [];
    if (content.includes('React.FC') || content.includes('interface Props')) {
      return [];
    }
    if (content.includes('const') && content.includes('=') && content.includes('=>')) {
      return [{
        message: 'Consider adding TypeScript types or PropTypes',
        severity: 'info'
      }];
    }
    return [];
  }
};

// Process changed files
changedFiles.forEach(file => {
  if (!fs.existsSync(file)) return;
  
  const content = fs.readFileSync(file, 'utf8');
  
  Object.values(rules).forEach(rule => {
    try {
      const ruleIssues = rule(file, content);
      ruleIssues.forEach(issue => {
        issues.push({ file, ...issue });
      });
    } catch (err) {
      console.error(`Error in rule for ${file}:`, err.message);
    }
  });
});

// Write output for GitHub Actions to consume
const output = {
  timestamp: new Date().toISOString(),
  filesReviewed: changedFiles.length,
  issuesFound: issues.length,
  issues: issues.slice(0, 10) // Limit to 10 issues
};

fs.writeFileSync('.github/review-output.json', JSON.stringify(output, null, 2));
console.log(`✅ Review complete: ${issues.length} issue(s) found`);
console.log(JSON.stringify(output, null, 2));
