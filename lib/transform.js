var mod = require('module').prototype;
var originalCompile = mod._compile;
var traverse = require('traverse');
var uglify = require('uglify-js_scriby');
var parser = uglify.parser;
var util = require('util');

var isInAsyncBlock = function(curr, asyncblockVarId){
    if(curr == null){
        return false;
    }

    var node = curr.node;

    if(node[0] === 'call' && node.containingScope.variables[node[1][1]] === asyncblockVarId){
        return true;
    } else {
        return isInAsyncBlock(curr.parent, asyncblockVarId);
    }
};

var _nextId = 0;
var nextId = function(){
    return _nextId++;
};

var processAST = function(traversal){
    var scopes = [];
    var variableDeclarationScopes = {};//{id: scope node}

    var addScope = function(scope){
        var node = scope.node;
        scopes.push(node);

        var container = findContainingScope(findContainingScope(scope).parent);

        Object.defineProperty(node, 'variables', { value: {}, enumerable: false });
        Object.defineProperty(node, 'variablesRev', { value: {}, enumerable: false });

        if(container){
            //Copy variables from the previous scope
            Object.keys(container.node.variables).forEach(function(key){
                var value = container.node.variables[key];

                node.variables[key] = value;
                node.variablesRev[value] = key;
            });
        }
    };

    var addVariable = function(varName){
        var currScope = scopes[scopes.length - 1];

        var existingId = currScope.variables[varName];
        if(existingId != null){
            delete currScope.variablesRev[existingId];
        }

        var id = nextId();
        currScope.variables[varName] = id;
        currScope.variablesRev[id] = varName;

        variableDeclarationScopes[id] = currScope;
    };

    var containingScope;

    traversal.forEach(function(){
        var node = this.node;

        if(typeof node === 'object' && node != null){
            if(containingScope == null){
                containingScope = node;
            }

            if(node[0] === 'function'){
                containingScope = node;
                containingScopeState = this;

                addScope(this);

                node[2].forEach(function(varName){
                    addVariable(varName);
                });

                this.after(function(){
                    scopes.pop();
                    containingScope = scopes[scopes.length - 1];
                });
            } else if(scopes.length === 0){
                //Push on the outermost scope
                addScope(this);
            } else if(node[0] === 'var'){
                var varName = node[1][0][0];

                addVariable(varName);
            }

            Object.defineProperty(node, 'containingScope', { value: containingScope, enumerable: false });
        }
    });

    return { variableDeclarationScopes: variableDeclarationScopes };
};

var findContainingScope = function(curr){
    if(curr == null || curr.parent == null){
        return curr;
    }

    var node = curr.node;

    if(node[0] === 'function'){
        return curr;
    } else {
        return findContainingScope(curr.parent);
    }
};

var replaceVariableAccess = function(node, varId, flowVarId){
    if(node instanceof Array){
        for(var i = 0; i < node.length; i++){
            if(node[i] != null){
                if(node[i][0] === 'name'){
                    if(node.containingScope){
                        var varName = node.containingScope.variablesRev[varId];

                        if(varName != null && varName === node[i][1]){
                            if(node[0] === 'assign' && node[1] === true){
                                //Don't replace calls to flow.something
                                //console.log(util.inspect(node, false, 10));

                                var assigned = node[3];
                                if(assigned[0] === 'call' && assigned[1][0] === 'dot' && node.containingScope.variables[assigned[1][1][1]] === flowVarId){
                                    //console.log(node);
                                } else {
                                    //Replace variable with variable.result
                                    node[2] = [ 'dot', node[2], 'result' ];
                                }
                            } else {
                                //Replace variable with variable.result
                                node.splice(i, 1, [ 'dot', node[i], 'result' ]);
                            }
                        }
                    }
                }

                replaceVariableAccess(node[i], varId, flowVarId);
            }
        }
    }
};

var enabled = false;
var maintainLines = false;

exports.enableTransform = function(){
    if(enabled){
        return;
    } else {
        enabled = true;
    }

    var maintainLines = true;
    var endingBackslashIndicator = 'agd897fta886d9vx0d0f5dasf86sf';
    var newlineIndicator = 'newline_ghas9df0s9gfkladfy';

    var newlineIndicatorRegex = new RegExp('//' + newlineIndicator, 'g');
    var endingBackslashIndicatorRegex = new RegExp(endingBackslashIndicator, 'g');

    mod._compile = function(content, filename) {
        //If the content doesn't contain "asyncblock", don't process it
        if(!(/asyncblock/.test(content))){
            return originalCompile.apply(this, arguments);
        }

        if(maintainLines){
            //Keep track of newlines so we don't change line numbers in the file
            //It's important to keep newlines in tact so stack traces & the debugger work as expected
            content = content.replace(/^(.*?)(.?)$/gm, function(match, g1, g2){
                if(g2 !== '\\'){
                    return match + '//' + newlineIndicator;
                } else {
                    //If the line is a string continuation, keep track of it as the parser will lose it and the lines will change
                    return g1 + endingBackslashIndicator + '\\';
                }
            });
        }

        //If we encounter a parsing error, revert to the built-in compilation function which gives a better error message
        try {
            var ast = parser.parse(content);
        } catch(e) {
            return originalCompile.apply(this, arguments);
        }

        var asyncblockVarId;
        var flowVarId;
        var flowVarName;

        var traversal = traverse(ast);

        var result = processAST(traversal);
        var variableDeclarationScopes = result.variableDeclarationScopes;
        var transformationMade = false;

        var topLevel = traversal.forEach(function(){
            var node = this.node;

            if(node != null){
                var containingScope = node.containingScope;

                if(node[0] === 'call' && node[1][1] === 'require' && node[2][0][1].slice(-10) === 'asyncblock'){
                    var varStatement = this.parent.parent.parent;
                    if(varStatement.node && varStatement.node[0] === 'var'){
                        asyncblockVarId = containingScope.variables[this.parent.node[0]];
                    }
                }

                if(containingScope){
                    if(node[0] === 'call' && asyncblockVarId != null && containingScope.variables[node[1][1]] === asyncblockVarId){
                        flowVarName = node[2][0][2][0];
                        flowVarId = node[2][0].containingScope.variables[flowVarName];
                    }

                    //Detect calls on the flow variable
                    if(node[0] === 'call' && node[1][0] === 'dot' && containingScope.variables[node[1][1][1]] !== flowVarId){
                        //Make sure we're in an asyncblock
                        if(isInAsyncBlock(this, asyncblockVarId)){
                            //If sync was called
                            if(node[1][2] === 'sync') {
                                //Remove the .sync part
                                node[1] = node[1][1];

                                //Add the flow.callback as the last arg
                                node[2].push(['call', ['dot', ['name', flowVarName], 'callback'] ]);

                                //Surround the node with a flow.sync
                                node.splice(0, 0, 'call', ['dot', ['name', flowVarName], 'sync']);
                                node[2] = [node.splice(2, node.length - 2)];

                                transformationMade = true;
                            } else if(node[1][2] === 'future') {
                                //Remove the .future part
                                node[1] = node[1][1];

                                //Add the flow.callback as the last arg
                                node[2].push(['call', ['dot', ['name', flowVarName], 'callback'] ]);

                                //Surround the node with a flow.sync
                                node.splice(0, 0, 'call', ['dot', ['name', flowVarName], 'future']);
                                node[2] = [node.splice(2, node.length - 2)];

                                transformationMade = true;
                            } else if(node[1][2] === 'defer'){
                                //Remove the .defer part
                                node[1] = node[1][1];

                                //Add the flow.callback as the last arg
                                node[2].push(['call', ['dot', ['name', flowVarName], 'callback'] ]);

                                //Surround the node with a flow.future
                                node.splice(0, 0, 'call', ['dot', ['name', flowVarName], 'future']);
                                node[2] = [node.splice(2, node.length - 2)];

                                //Check for an assignment
                                var parent = this.parent.node;
                                var parent3x = this.parent.parent.parent.node;

                                var assignedToName;
                                if(parent[0] === 'assign' && parent[1] === true){
                                    assignedToName = parent[2][1];
                                } else if(parent3x[0] === 'var'){
                                    assignedToName = parent3x[1][0][0];
                                } else if(parent[0] === 'return'){
                                    //If returning immediately, we should use sync instead of future
                                    node[1][2] = 'sync';
                                }

                                //Replace variable accesses with variable.result
                                if(assignedToName != null){
                                    var varId = containingScope.variables[assignedToName];

                                    //Start replacing from the scope from which the variable was created
                                    replaceVariableAccess(variableDeclarationScopes[varId], varId, flowVarId);
                                }

                                transformationMade = true;
                            }
                        }
                    }
                }
            }
        });

        //If nothing was changed, use the original source
        if(transformationMade){
            var parsed = uglify.uglify.gen_code(topLevel, { beautify : false });

            if(maintainLines){
                //Comments already get newlines appended after them, so just remove the newline indicators
                parsed = parsed.replace(newlineIndicatorRegex, '');

                //Restore strings ending in \
                parsed = parsed.replace(endingBackslashIndicatorRegex, '\\\n');
            }

            content = parsed;
        }

        return originalCompile.apply(this, arguments);
    };
};