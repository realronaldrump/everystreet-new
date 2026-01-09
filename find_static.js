const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { execSync } = require("child_process");

const jsFiles = execSync('find static/js -name "*.js"', { encoding: "utf8" })
  .trim()
  .split("\n");

const allCandidates = [];
jsFiles.forEach((file) => {
  try {
    const code = fs.readFileSync(file, "utf8");
    const ast = acorn.parse(code, {
      ecmaVersion: 2020,
      sourceType: "module",
      allowImportExportEverywhere: true,
    });

    const candidates = [];

    function walk(node, className = null) {
      if (node.type === "ClassDeclaration") {
        className = node.id.name;
        node.body.body.forEach((member) => walk(member, className));
      } else if (node.type === "MethodDefinition" && node.kind === "method") {
        const methodName = node.key.name;
        if (methodName === "constructor") return;

        // Check if method uses 'this'
        let usesThis = false;
        function checkThis(n) {
          if (n.type === "ThisExpression") {
            usesThis = true;
          }
          for (const key in n) {
            if (n[key] && typeof n[key] === "object") {
              if (Array.isArray(n[key])) {
                n[key].forEach(checkThis);
              } else {
                checkThis(n[key]);
              }
            }
          }
        }
        checkThis(node);

        if (!usesThis) {
          candidates.push({ className, methodName, filePath: file });
        }
      }
    }

    walk(ast);
    allCandidates.push(...candidates);
  } catch (e) {
    console.error(`Error parsing ${file}:`, e.message);
  }
});

console.log(JSON.stringify(allCandidates, null, 2));
