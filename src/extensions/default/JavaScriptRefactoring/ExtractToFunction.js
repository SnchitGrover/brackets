/*
* Copyright (c) 2013 - present Adobe Systems Incorporated. All rights reserved.
*
* Permission is hereby granted, free of charge, to any person obtaining a
* copy of this software and associated documentation files (the "Software"),
* to deal in the Software without restriction, including without limitation
* the rights to use, copy, modify, merge, publish, distribute, sublicense,
* and/or sell copies of the Software, and to permit persons to whom the
* Software is furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
* DEALINGS IN THE SOFTWARE.
*
*/

define(function(require, exports, module) {
    'use strict';

    var Acorn               = brackets.getModule("thirdparty/acorn/dist/acorn"),
        ASTWalker           = brackets.getModule("thirdparty/acorn/dist/walk"),
        Menus               = brackets.getModule("command/Menus"),
        CommandManager      = brackets.getModule("command/CommandManager"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        KeyBindingManager   = brackets.getModule("command/KeyBindingManager"),
        _                   = brackets.getModule("thirdparty/lodash"),
        StringUtils         = brackets.getModule("utils/StringUtils"),
        Session             = brackets.getModule("JSUtils/Session"),
        RefactoringUtils    = require("RefactoringUtils"),
        InlineMenu          = require("InlineMenu").InlineMenu;

    var template = JSON.parse(require("text!templates.json"));

    var session = null;

    // Error messages
    var TERN_FAILED             = "Unable to get data from Tern",
        EXTRACTFUNCTION_ERR_MSG = "Selected block should represent set of statements or an expression";

    /*
     * Analyzes the code and finds values required for extract to function
     * @param {!string} text - text to be extracted
     * @param {!Array.<Scope>} - scopes
     * @param {!Scope} srcScope - source scope of the extraction
     * @param {!Scope} destScope - destination scope of the extraction
     * @param {!number} start - the start offset
     * @param {!number} end - the end offset
     * @return {!{
     *          passParams: Array.<string>,
     *          retParams: Array.<string>,
     *          thisPointerUsed: boolean,
     *          varaibleDeclarations: {} // variable-name: kind
     * }}
     */
    function analyzeCode(text, scopes, srcScope, destScope, start, end) {
        var identifiers          = {},
            inThisScope          = {},
            thisPointerUsed      = false,
            variableDeclarations = {},
            changedValues        = {},
            dependentValues      = {},
            doc                  = session.editor.document,
            ast                  = Acorn.parse_dammit(text, { ecmaVersion: 9 }),
            restScopeStr;

        ASTWalker.full(ast, function(node) {
            var value, name;
            switch (node.type) {
                case "AssignmentExpression":
                    value = node.left;
                    break;
                case "VariableDeclarator":
                    inThisScope[node.id.name] = true;
                    value = node.init && node.id;
                    var variableDeclarationNode = RefactoringUtils.findSurroundASTNode(ast, node, ["VariableDeclaration"]);
                    variableDeclarations[node.id.name] = variableDeclarationNode.kind;
                    break;
                case "ThisExpression":
                    thisPointerUsed = true;
                    break;
                case "UpdateExpression":
                    value = node.argument;
                    break;
                case "Identifier":
                    identifiers[node.name] = true;
                    break;
            }
            if (value){
                if (value.type === "MemberExpression") {
                    name = value.object.name;
                } else {
                    name = value.name;
                }
                changedValues[name] = true;
            }
        });

        if (srcScope.originNode) {
            restScopeStr = doc.getText().substr(end, srcScope.originNode.end - end);
        } else {
            restScopeStr = doc.getText().substr(end);
        }

        ASTWalker.simple(Acorn.parse_dammit(restScopeStr, {ecmaVersion: 9}), {
            Identifier: function(node) {
                var name = node.name;
                dependentValues[name] = true;
            },
            Expression: function(node) {
                if (node.type === "MemberExpression") {
                    var name = node.object.name;
                    dependentValues[name] = true;
                }
            }
        });

        var props = scopes.slice(srcScope.id, destScope.id).reduce(function(props, scope) {
            return _.union(props, _.keys(scope.props));
        }, []);

        return {
            passParams:           _.intersection(_.difference(_.keys(identifiers), _.keys(inThisScope)), props),
            retParams:            _.intersection( _.keys(changedValues), _.keys(dependentValues), props),
            thisPointerUsed:      thisPointerUsed,
            variableDeclarations: variableDeclarations
        };
    }

    /*
     * Does the actual extraction. i.e Replacing the text, Creating a function
     * and multi select function names
     */
    function extract(text, scopes, srcScope, destScope, start, end, isExpression) {
        var retObj               = analyzeCode(text, scopes, srcScope, destScope, start, end),
            passParams           = retObj.passParams,
            retParams            = retObj.retParams,
            thisPointerUsed      = retObj.thisPointerUsed,
            variableDeclarations = retObj.variableDeclarations,
            doc                  = session.editor.document,
            fnBody               = text,
            fnName               = RefactoringUtils.getUniqueIdentifierName(destScope, "extracted"),
            fnDeclaration,
            fnCall;

        function appendVarDeclaration(identifier) {
            if (variableDeclarations.hasOwnProperty(identifier)) {
                 return variableDeclarations[identifier] + " " + identifier;
            }
            else {
                 return identifier;
            }
        }

        if (destScope.isClass) {
            fnCall = StringUtils.format(template.functionCall.class, fnName, passParams.join(", "));
        } else if (thisPointerUsed) {
            passParams.unshift("this");
            fnCall = StringUtils.format(template.functionCall.thisPointer, fnName, passParams.join(", "));
            passParams.shift();
        } else {
            fnCall = StringUtils.format(template.functionCall.normal, fnName, passParams.join(", "));
        }
        if (isExpression) {
            fnBody = StringUtils.format(template.returnStatement.single, fnBody);
        } else {

            var retParamsStr = "";
            if (retParams.length > 1) {
                retParamsStr = StringUtils.format(template.returnStatement.multiple, retParams.join(", "));
                fnCall = "var ret = " + fnCall + ";\n";
                fnCall += retParams.map(function (param) {
                    return StringUtils.format(template.assignment, appendVarDeclaration(param),  "ret." + param);
                }).join("\n");
            } else if (retParams.length === 1) {
                retParamsStr = StringUtils.format(template.returnStatement.single, retParams.join(", "));
                fnCall = StringUtils.format(template.assignment, appendVarDeclaration(retParams[0]), fnCall);
            } else {
                fnCall += ";";
            }

            fnBody = fnBody + "\n" + retParamsStr;
        }

        if (destScope.isClass) {
            fnDeclaration = StringUtils.format(template.functionDeclaration.class, fnName, passParams.join(", "), fnBody);
        } else {
            fnDeclaration = StringUtils.format(template.functionDeclaration.normal, fnName, passParams.join(", "), fnBody);
        }

        start = session.editor.posFromIndex(start);
        end   = session.editor.posFromIndex(end);

        // Get the insertion pos for function declaration
        var insertPos = _.clone(start);
        var fnScopes = scopes.filter(RefactoringUtils.isFnScope);

        for (var i = 0; i < fnScopes.length; ++i) {
            if (fnScopes[i].id === destScope.id) {
                if (fnScopes[i - 1]) {
                     insertPos = session.editor.posFromIndex(fnScopes[i - 1].originNode.start);
                }
                break;
            }
        }
        insertPos.ch = 0;

        // Replace and indent
        doc.batchOperation(function() {
            doc.replaceRange(fnCall, start, end);
            session.editor.setCursorPos(start);
            for (var i = start.line; i < start.line + RefactoringUtils.numLines(fnCall); ++i) {
                session.editor._codeMirror.indentLine(i, "smart");
            }
            doc.replaceRange(fnDeclaration, insertPos);
            for (var i = insertPos.line; i < insertPos.line + RefactoringUtils.numLines(fnDeclaration); ++i) {
                session.editor._codeMirror.indentLine(i, "smart");
            }
        });

        console.log(fnDeclaration);
        console.log(fnCall);
    }

    /*
     * Main function that handles extract to function
     */
    function handleExtractToFunction() {
        var editor = EditorManager.getActiveEditor();

        if (editor.getSelections().length > 1) {
            editor.displayErrorMessageAtCursor("Extract to function does not work in multicursors");
        }
        initializeSession(editor);

        var selection = editor.getSelection(),
            doc       = editor.document,
            retObj    = RefactoringUtils.normalizeText(editor.getSelectedText(), editor.indexFromPos(selection.start), editor.indexFromPos(selection.end)),
            text      = retObj.text,
            start     = retObj.start,
            end       = retObj.end,
            ast,
            scopes,
            expns,
            inlineMenu;

        RefactoringUtils.getScopeData(session, editor.posFromIndex(start)).done(function(scope) {
            ast = Acorn.parse_dammit(doc.getText(), {ecmaVersion: 9});

            var isExpression = false;
            if (!RefactoringUtils.checkStatement(ast, start, end, doc.getText())) {
                isExpression = RefactoringUtils.getExpression(ast, start, end, doc.getText());
                if (!isExpression) {
                    editor.displayErrorMessageAtCursor(EXTRACTFUNCTION_ERR_MSG);
                    return;
                }
            }
            scopes = RefactoringUtils.getAllScopes(ast, scope, doc.getText());

            inlineMenu = new InlineMenu(editor, "Choose destination scope");

            inlineMenu.open(scopes.filter(RefactoringUtils.isFnScope));

            inlineMenu.onSelect(function (scopeId) {
                extract(text, scopes, scopes[0], scopes[scopeId], start, end, isExpression);
                inlineMenu.close();
            });

            inlineMenu.onClose(function(){});
        }).fail(function() {
            editor.displayErrorMessageAtCursor(TERN_FAILED);
        });
    }

    /*
     * Creates a new session from editor and stores it in session global variable
     */
    function initializeSession(editor) {
        session = new Session(editor);
    }

    /*
     * Adds the commands for extract to variable
     */
    function addCommands() {
        // Extract To Function
        CommandManager.register("Extract To Function", "refactoring.extractToFunction", handleExtractToFunction);
        KeyBindingManager.addBinding("refactoring.extractToFunction", "Ctrl-Shift-M");
        Menus.getContextMenu(Menus.ContextMenuIds.EDITOR_MENU).addMenuItem("refactoring.extractToFunction");
    }

    exports.addCommands = addCommands;
});

// Commented blocks
// extractToFunction
           // var expression = getSingleExpression(start, end);
           // var parentStatement = findParentStatement(expression);
           // if (parentStatement.type !== "ExpressionStatement" || !isEqual(parentStatement.expression, parentStatement)) {
           //     fnbody = "return " + fnbody + ";";
           // }