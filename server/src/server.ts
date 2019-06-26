/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind,
	Diagnostic, DiagnosticSeverity, TextDocument
} from 'vscode-languageserver';

import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import fileUriToPath from './fileUriToPath';

import { Template, Clause } from '@accordproject/cicero-core';
import { TemplateLogic } from '@accordproject/ergo-compiler';
import { ModelFile } from 'composer-concerto';

const util = require('util');

// Creates the LSP connection
let connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
let documents = new TextDocuments();

// The workspace folder this server is operating on
let workspaceFolder: string;

// an empty range (this will highlight the first word in the document)
const FULL_RANGE = {
    start: { line: 0, character: 0 },
    end:  { line: 0, character: 0 },
};

/**
 * Gets the root file path for a template, from a path under the root, by walking
 * up the directory hierarchy looking for a package.json file that contains the 
 * 'accordproject' key. If a valid package.json is missing then a diagnostic error is
 * pushed for the textDocument and null is returned
 * @param {string} pathStr the full path
 * @param {TextDocument} textDocument the textDocument we are processing
 * @returns {string} the root file path
 */
function getTemplateRoot(pathStr, textDocument, diagnosticMap) {

    let currentPath = pathStr;

    while(currentPath !== '.') {
        connection.console.log( `- ${currentPath}`);

        try {
            const packageJsonContents = fs.readFileSync(currentPath + '/package.json', 'utf8');
            const packageJson = JSON.parse(packageJsonContents);
            if(packageJson.accordproject) {
                return currentPath;
            }
        }
        catch(err) {
            connection.console.log( `- exception ${err}`);
            currentPath = path.normalize(path.join(currentPath, '..'));
        }
    }

    connection.console.log( `Failed to find template path for ${pathStr}`);
    const error = {message: `${pathStr} is not a sub-folder of an Accord Project template. Ensure a parent folder contains a valid package.json.`};
    pushError(textDocument, error, 'template', diagnosticMap);
    return null;
}

/**
 * Lots of hacks to extract line numbers from exceptions
 * 
 * @param error the exception
 * @returns the range object
 */
function getRange(error: any) {
    if(error.fileLocation) {
        return {
            start: { line: error.fileLocation.start.line-1, character: error.fileLocation.start.column },
            end: { line: error.fileLocation.end.line-1, character: error.fileLocation.end.column }
        };
    }
    else if(error.descriptor) {
        if(error.descriptor.kind === 'CompilationError' || error.descriptor.kind === 'TypeError') {
            if(error.descriptor.locstart.line > 0) {
                const startRange = { line: error.descriptor.locstart.line-1, character: error.descriptor.locstart.character };
                return {
                    start: startRange,
                    end: startRange
                }
            }
            if(error.descriptor.locend.line > 0) {
                return {
                    start: { line: 0, character: 0 },
                    end: { line: error.descriptor.locend.line-1, character: error.descriptor.locend.character }
                }
            }
        }
        else {
            return {
                start: { line: error.descriptor.locstart.line-1, character: error.descriptor.locstart.character },
                end:  { line: error.descriptor.locend.line-1, character: error.descriptor.locend.character },
            }
        }
    }
    
    return FULL_RANGE;
}

/**
 * Converts an error (exception) to a VSCode Diagnostic and
 * pushes it onto the diagnosticMap
 * @param textDocument the text document associated (the doc that has been modified)
 * @param error the exception
 * @param type the type of the exception
 */
function pushError(textDocument: TextDocument, error : any, type : string, diagnosticMap) {

    connection.console.log(util.inspect(error, false, null))

    let fileName = error.fileName;

    // hack to extract the filename from the verbose message
    if(!fileName && error.descriptor && error.descriptor.verbose) {
        const regex = /.+at file (.+\.ergo).+/gm;
        const match = regex.exec(error.descriptor.verbose);
        connection.console.log(`Match: ${match}`);
        if(match && match.length > 0) {
            fileName = match[1];
            connection.console.log(`fileName: ${fileName}`);
        }
    }

    // hack to extract the filename from the model file
    if(!fileName && error.getModelFile && error.getModelFile()) {
        fileName = error.getModelFile().getName();
    }

    let diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: getRange(error),
        message: error.message,
        source: type
    };

    // last resort, we assume the error is related
    // to the document that was just changed
    if(!fileName) {
        fileName = textDocument.uri;
    }

    // if we have a fileName, that is different from the
    // file that was just modified then we create related information
    // if(fileName && textDocument.uri !== fileName) {
    //     diagnostic.relatedInformation = [
    //         {
    //           location: {
    //             uri: fileName,
    //             range: Object.assign({}, getRange(error))
    //           },
    //           message: error.message
    //         },
    //       ];    
    // }

    // add the diagnostic
    if(!diagnosticMap[fileName]) {
        diagnosticMap[fileName] = new Set();
    }
    
    diagnosticMap[fileName].add(diagnostic);
}

/**
 * Declares that a file has no errors in the diagnostic map.
 * We need to call this on all files that DO NOT have errors
 * to ensure that error markers are removed.
 * 
 * @param fileName the uri of the file
 * @param diagnosticMap the diagnostic map
 */
function validFile(fileName, diagnosticMap) {
    diagnosticMap[fileName] = new Set();
}

/**
 * Called when a document is opened
 */
documents.onDidOpen((event) => {
	connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Document opened: ${event.document.uri}`);
})

/**
 * Connect the document connection to the client
 */
documents.listen(connection);

/**
 * Called when the extension initializes
 */
connection.onInitialize((params) => {
	workspaceFolder = params.rootUri;
	connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Started and initialize received`);
	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full
			}
		}
	}
});

/**
 * The content of a text document has changed. This event is emitted
 * when the text document is first opened or when its content has changed.
 */
documents.onDidChangeContent(async (change) => {
	  // Revalidate any open text documents
    documents.all().forEach(validateTextDocument);
});

/**
 * Called when the contents of a document changes
 * 
 * @param textDocument - a TextDocument
 */
async function validateTextDocument(textDocument: TextDocument): Promise<void> {

    try {
        connection.console.log(`*** Document modified: ${textDocument.uri}`);

        /**
         * A cache of TemplateLogic instances. The keys are the root folder names.
         */
        const templateCache = {};

        /**
         * Map of diagnostics, with the key being the document URI
         * and the value being a Set of Diagnostic instances
         */
        const diagnosticMap = {
        }

        const pathStr = path.resolve(fileUriToPath(textDocument.uri));
        const fileExtension = path.extname(pathStr);
        
        // this will assemble all the models into a ModelManager
        // and validate - so it needs to always run before we do anything else
        const modelValid = await validateModels(textDocument, diagnosticMap, templateCache);
    
        // if the model is valid, then we proceed
        if(modelValid) {
            switch(fileExtension) {
                case '.cto':
                        // if a cto file has been modified then we check all ergo files and the template
                        const ergoValid = await compileErgoFiles(textDocument, diagnosticMap, templateCache);
    
                        // if ergo is valid we proceed to check the template
                        if(ergoValid) {
                            await validateTemplateFile(textDocument, diagnosticMap);
                        }
                    break;
                case '.ergo':
                    // if ergo code has changed, we recompile all ergo
                    await compileErgoFiles(textDocument, diagnosticMap, templateCache);
                    break;
                case '.tem':
                    // if a template file has changed, we check we can build the template
                    await validateTemplateFile(textDocument, diagnosticMap);
                    break;
            }    
        }
    
        // send all the diagnostics we have accumulated back to the client
        Object.keys(diagnosticMap).forEach(function(key) {
            const fileDiagnostics : Set<Diagnostic> = diagnosticMap[key];
            connection.sendDiagnostics({ uri: key, diagnostics : [...fileDiagnostics] });
          });
    }
    catch(error) {
        connection.console.error(error.message);
        connection.console.error(error.stack);
    }
}

/**
 * Validate a change to an ergo file: we recompile all ergo files.
 * 
 * @param textDocument - a TextDocument (Ergo file or a CTO file)
 * @return Promise<boolean> true the ergo files are valid
 */
async function compileErgoFiles(textDocument: TextDocument, diagnosticMap, templateCache): Promise<boolean> {

    try {
        const pathStr = path.resolve(fileUriToPath(textDocument.uri));
        const folder = pathStr.substring(0,pathStr.lastIndexOf("/")+1);
        const parentDir = getTemplateRoot(pathStr, textDocument, diagnosticMap);

        if(!parentDir) {
            return false;
        }

        try {
            // get the template logic from cache
            let templateLogic = templateCache[parentDir];
            connection.console.log(`Compiling ergo files under: ${parentDir}`);
    
            // Find all ergo files in ./ relative to this file
            const ergoFiles = glob.sync(`{${folder},${parentDir}/lib/}**/*.ergo`);
            for (const file of ergoFiles) {
                validFile(file, diagnosticMap);
                if (file === pathStr) {
                    // Update the current file being edited
                    connection.console.log(`**** using contents for: ${textDocument.uri}`);
                    templateLogic.updateLogic(textDocument.getText(), pathStr);
                } else {
                    connection.console.log(file);
                    const contents = fs.readFileSync(file, 'utf8');
                    templateLogic.updateLogic(contents, file);
                }
            }
            await templateLogic.compileLogic(true);
            return true;
        } catch (error) {
            pushError(textDocument, error, 'logic', diagnosticMap);
        }
    }
    catch(error) {
        connection.console.error(error.message);
        connection.console.error(error.stack);
    }

    return false;
}

/**
 * Rebuild the model manager and validates all the models
 * 
 * @param textDocument - a TextDocument
 * @return Promise<boolean> true the model is valid
 */
async function validateModels(textDocument: TextDocument, diagnosticMap, templateCache): Promise<boolean> {
    const pathStr = path.resolve(fileUriToPath(textDocument.uri));
    const folder = pathStr.substring(0,pathStr.lastIndexOf("/")+1);

    try {
        const parentDir = getTemplateRoot(pathStr, textDocument, diagnosticMap);
        if(!parentDir) {
            return false;
        }
        connection.console.log(`Validating model files under: ${parentDir}`);

        // get the template logic from cache
        let templateLogic = templateCache[parentDir];

        if(!templateLogic) {
            templateLogic = new TemplateLogic('cicero');
            templateCache[parentDir] = templateLogic;
        }
        
        const modelManager = templateLogic.getModelManager();
        modelManager.clearModelFiles();
    
        // Find all cto files in ./ relative to this file or in the parent directory if this is a Cicero template.
        const modelFiles = glob.sync(`{${folder},${parentDir}/models/}**/*.cto`);

        // validate the model files
        try {
            for (const file of modelFiles) {
                validFile(file, diagnosticMap);
                let contents = null;
                if (file === pathStr) {
                    // Update the current file being edited
                    contents = textDocument.getText();
                    connection.console.log(`**** using contents for: ${textDocument.uri}`);
                } else {
                    contents = fs.readFileSync(file, 'utf8');
                }

                const modelFile: any = new ModelFile(modelManager, contents, file);
                if (!modelManager.getModelFile(modelFile.getNamespace())) {
                    modelManager.addModelFile(contents, file, true);
                } else {
                    modelManager.updateModelFile(contents, file, true);
                }
            }

            // download external dependencies and validate
            await modelManager.updateExternalModels();
            return true;
        }
        catch(error) {
            pushError(textDocument, error, 'model', diagnosticMap);
        }
    }
    catch(error) {
        connection.console.error(error.message);
        connection.console.error(error.stack);
    }

    return false;
}

/**
 * Validate that we can build the template archive and parse sample.txt
 * 
 * @param textDocument - a TextDocument
 * @return Promise<boolean> true the template and sample.txt are valid
 */
async function validateTemplateFile(textDocument: TextDocument, diagnosticMap): Promise<boolean> {

    try {
        const pathStr = path.resolve(fileUriToPath(textDocument.uri));
        const parentDir = getTemplateRoot(pathStr, textDocument, diagnosticMap);
        if(!parentDir) {
            return false;
        }

        try {
            connection.console.log(`Validating template under: ${parentDir}`);
            validFile(parentDir + '/grammar/template.tem', diagnosticMap);
            const template = await Template.fromDirectory(parentDir);
            template.parserManager.buildGrammar(textDocument.getText());
            template.validate();
            
            try {
                connection.console.log(`Built template: ${template.getIdentifier()}`);
                validFile(parentDir + '/sample.txt', diagnosticMap);
                const sample = fs.readFileSync(parentDir + '/sample.txt', 'utf8');
                const clause = new Clause(template);
                clause.parse(sample);
                connection.console.log(`Parsed sample.text: ${JSON.stringify(clause.getData(), null, 2)}`);
                return true;
            }
            catch(error) {
                error.fileName = parentDir + '/sample.txt';
                pushError(textDocument, error, 'sample', diagnosticMap);
            }
        }
        catch(error) {
            error.fileName = parentDir + '/grammar/template.tem';
            pushError(textDocument, error, 'template', diagnosticMap);
        }
    }
    catch(error) {
        connection.console.error(error.message);
        connection.console.error(error.stack);
    }

    return false;
}

connection.listen();