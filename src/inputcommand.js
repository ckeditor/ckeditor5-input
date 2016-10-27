/**
 * @license Copyright (c) 2003-2016, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

import ChangeBuffer from './changebuffer.js';

import Command from '../core/command/command.js';
import ModelRange from '../engine/model/range.js';
import ViewPosition from '../engine/view/position.js';
import ViewText from '../engine/view/text.js';

import diff from '../utils/diff.js';
import diffToChanges from '../utils/difftochanges.js';

/**
 * The input command. Used by the {@link typing.Input input feature} to handle inserting new characters.
 *
 * @member typing
 * @extends core.command.Command
 */
export default class InputCommand extends Command {
	/**
	 * Creates an instance of the command.
	 *
	 * @param {core.editor.Editor} editor
	 */
	constructor( editor ) {
		super( editor );

		/**
		 * Input's change buffer used to group subsequent changes into batches.
		 *
		 * @readonly
		 * @private
		 * @member {typing.ChangeBuffer} typing.InputCommand#buffer
		 */
		this._buffer = new ChangeBuffer( editor.document, editor.config.get( 'undo.step' ) || 20 );

		/**
		 * @readonly
		 * @private
		 */
		this._handler = new MutationHandler( this.editor.editing, this._buffer );
	}

	/**
	 * Executes the input command. Depending on the `inputType` it handles `keydown` or `mutation` input.
	 *
	 * @param {Object} options The command options.
	 * @param {Array.<Object>} options.mutations List of view mutations.
	 * @param {engine.view.Selection} [options.viewSelection] Selection object of view.
	 */
	_doExecute( options = {} ) {
		const { mutations, viewSelection } = options;

		this._handleMutations( mutations, viewSelection );
	}

	/**
	 * Handles DOM mutations.
	 *
	 * @param {Array.<engine.view.Document~MutatatedText|engine.view.Document~MutatatedChildren>} mutations
	 */
	_handleMutations( mutations, viewSelection ) {
		const doc = this.editor.document;

		doc.enqueueChanges( () => this._handler.handle( mutations, viewSelection ) );
	}
}

/**
 * Helper class for translating DOM mutations into model changes.
 *
 * @private
 * @member typing.Input
 */
class MutationHandler {
	/**
	 * Creates an instance of the mutation handler.
	 *
	 * @param {engine.EditingController} editing
	 * @param {typing.ChangeBuffer} buffer
	 */
	constructor( editing, buffer ) {
		/**
		 * The editing controller.
		 *
		 * @member {engine.EditingController} typing.Input.MutationHandler#editing
		 */
		this.editing = editing;

		/**
		 * The change buffer.
		 *
		 * @member {engine.EditingController} typing.Input.MutationHandler#buffer
		 */
		this.buffer = buffer;

		/**
		 * The number of inserted characters which need to be fed to the {@link #buffer change buffer}
		 * on {@link #commit}.
		 *
		 * @member {Number} typing.Input.MutationHandler#insertedCharacterCount
		 */
		this.insertedCharacterCount = 0;
	}

	/**
	 * Handles given mutations.
	 *
	 * @param {Array.<engine.view.Document~MutatatedText|engine.view.Document~MutatatedChildren>} mutations
	 */
	handle( mutations, viewSelection ) {
		for ( let mutation of mutations ) {
			// Fortunately it will never be both.
			this._handleTextMutation( mutation, viewSelection );
			this._handleTextNodeInsertion( mutation );
		}

		this.buffer.input( Math.max( this.insertedCharacterCount, 0 ) );
	}

	_handleTextMutation( mutation, viewSelection ) {
		if ( mutation.type != 'text' ) {
			return;
		}

		// Replace &nbsp; inserted by the browser with normal space.
		// We want only normal spaces in the model and in the view. Renderer and DOM Converter will be then responsible
		// for rendering consecutive spaces using &nbsp;, but the model and the view has to be clear.
		// Other feature may introduce inserting non-breakable space on specific key stroke (for example shift + space).
		// However then it will be handled outside of mutations, like enter key is.
		// The replacing is here because it has to be done before `diff` and `diffToChanges` functions, as they
		// take `newText` and compare it to (cleaned up) view.
		// It could also be done in mutation observer too, however if any outside plugin would like to
		// introduce additional events for mutations, they would get already cleaned up version (this may be good or not).
		const newText = mutation.newText.replace( /\u00A0/g, ' ' );
		// To have correct `diffResult`, we also compare view node text data with &nbsp; replaced by space.
		const oldText = mutation.oldText.replace( /\u00A0/g, ' ' );

		const diffResult = diff( oldText, newText );

		// Index where the first change happens. Used to set the position from which nodes will be removed and where will be inserted.
		let firstChangeAt = null;
		// Index where the last change happens. Used to properly count how many characters have to be removed and inserted.
		let lastChangeAt = null;

		// Get `firstChangeAt` and `lastChangeAt`.
		for ( let i = 0; i < diffResult.length; i++ ) {
			const change = diffResult[ i ];

			if ( change != 'equal' ) {
				firstChangeAt = firstChangeAt === null ? i : firstChangeAt;
				lastChangeAt = i;
			}
		}

		// How many characters, starting from `firstChangeAt`, should be removed.
		let deletions = 0;
		// How many characters, starting from `firstChangeAt`, should be inserted (basing on mutation.newText).
		let insertions = 0;

		for ( let i = firstChangeAt; i <= lastChangeAt; i++ ) {
			// If there is no change (equal) or input, the character is existing in `oldText`. We count it for removing.
			if ( diffResult[ i ] != 'insert' ) {
				deletions++;
			}

			// If there is no change (equal) or insert, the character is existing in `newText`. We count it for inserting.
			if ( diffResult[ i ] != 'delete' ) {
				insertions++;
			}
		}

		// Try setting new model selection according to passed view selection.
		let modelSelectionPosition = null;

		if ( viewSelection ) {
			modelSelectionPosition = this.editing.mapper.toModelPosition( viewSelection.anchor );
		}

		// Get the position in view and model where the changes will happen.
		const viewPos = new ViewPosition( mutation.node, firstChangeAt );
		const modelPos = this.editing.mapper.toModelPosition( viewPos );

		// Remove appropriate number of characters from the model text node.
		if ( deletions > 0 ) {
			const removeRange = ModelRange.createFromPositionAndShift( modelPos, deletions );
			this._remove( removeRange, deletions );
		}

		// Insert appropriate characters basing on `mutation.text`.
		const insertedText = mutation.newText.substr( firstChangeAt, insertions );
		this._insert( modelPos, insertedText );

		// If there was `viewSelection` and it got correctly mapped, collapse selection at found model position.
		if ( modelSelectionPosition ) {
			this.editing.model.selection.collapse( modelSelectionPosition );
		}
	}

	_handleTextNodeInsertion( mutation ) {
		if ( mutation.type != 'children' ) {
			return;
		}

		// One new node.
		if ( mutation.newChildren.length - mutation.oldChildren.length != 1 ) {
			return;
		}

		// Which is text.
		const diffResult = diff( mutation.oldChildren, mutation.newChildren, compareChildNodes );
		const changes = diffToChanges( diffResult, mutation.newChildren );

		// In case of [ input, insert, insert ] the previous check will not exit.
		if ( changes.length > 1 ) {
			return;
		}

		const change = changes[ 0 ];

		// Which is text.
		if ( !( change.values[ 0 ] instanceof ViewText ) ) {
			return;
		}

		const viewPos = new ViewPosition( mutation.node, change.index );
		const modelPos = this.editing.mapper.toModelPosition( viewPos );
		let insertedText = change.values[ 0 ].data;

		// Replace &nbsp; inserted by the browser with normal space.
		// See comment in `_handleTextMutation`.
		// In this case we don't need to do this before `diff` because we diff whole nodes.
		// Just change &nbsp; in case there are some.
		insertedText = insertedText.replace( /\u00A0/g, ' ' );

		this._insert( modelPos, insertedText );

		this.editing.model.selection.collapse( modelPos.parent, 'end' );
	}

	_insert( position, text ) {
		this.buffer.batch.weakInsert( position, text );

		this.insertedCharacterCount += text.length;
	}

	_remove( range, length ) {
		this.buffer.batch.remove( range );

		this.insertedCharacterCount -= length;
	}
}

// Helper function that compares whether two given view nodes are same. It is used in `diff` when it's passed an array
// with child nodes.
function compareChildNodes( oldChild, newChild ) {
	if ( oldChild instanceof ViewText && newChild instanceof ViewText ) {
		return oldChild.data === newChild.data;
	} else {
		return oldChild === newChild;
	}
}
