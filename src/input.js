/**
 * @license Copyright (c) 2003-2016, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

'use strict';

import Feature from '../feature.js';
import ChangeBuffer from './changebuffer.js';
import ModelPosition from '../engine/model/position.js';
import ModelRange from '../engine/model/range.js';
import ViewPosition from '../engine/view/position.js';
import ViewText from '../engine/view/text.js';
import diff from '../utils/diff.js';
import diffToChanges from '../utils/difftochanges.js';
import { getCode } from '../utils/keyboard.js';

/**
 * The input feature.
 *
 * @memberOf input
 * @extends ckeditor5.Feature
 */
export default class Input extends Feature {
	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;
		const editingView = editor.editing.view;

		/**
		 * Typing's change buffer used to group subsequent changes into batches.
		 *
		 * @protected
		 * @member {input.ChangeBuffer} input.Input#_buffer
		 */
		this._buffer = new ChangeBuffer( editor.document, editor.config.get( 'input.undoStep' ) || 20 );

		// TODO The above default config value should be defines using editor.config.define() once it's fixed.

		this.listenTo( editingView, 'keydown', ( evt, data ) => {
			this._handleKeydown( data );
		}, null, 9999 ); // LOWEST

		this.listenTo( editingView, 'mutations', ( evt, mutations ) => {
			this._handleMutations( mutations );
		} );
	}

	/**
	 * @inheritDoc
	 */
	destroy() {
		super.destroy();

		this._buffer.destroy();
		this._buffer = null;
	}

	/**
	 * Handles keydown event. We need to guess whether such a keystroke is going to result
	 * in typing. If so, then before character insertion happens, we need to delete
	 * any selected content. Otherwise, a default browser deletion mechanism would be
	 * triggered, resulting in:
	 *
	 * * hundreds of mutations which couldn't be handled,
	 * * but most importantly, loss of a control over how content is being deleted.
	 *
	 * The method is used in a low-prior listener, hence allowing other listeners (e.g. delete or enter features)
	 * to handle the event.
	 *
	 * @private
	 * @param {engine.view.observer.keyObserver.KeyEventData} evtData
	 */
	_handleKeydown( evtData ) {
		const doc = this.editor.document;

		if ( isSafeKeystroke( evtData ) || doc.selection.isCollapsed ) {
			return;
		}

		doc.enqueueChanges( () => {
			doc.composer.deleteContents( this._buffer.batch, doc.selection );
		} );
	}

	/**
	 * Handles DOM mutations.
	 *
	 * @param {Array.<engine.view.Document~MutatatedText|engine.view.Document~MutatatedChildren>} mutations
	 */
	_handleMutations( mutations ) {
		const doc = this.editor.document;
		const handler = new MutationHandler( this.editor.editing, this._buffer );

		doc.enqueueChanges( () => handler.handle( mutations ) );
	}
}

/**
 * Helper class for translating DOM mutations into model changes.
 *
 * @private
 * @member input.input
 */
class MutationHandler {
	/**
	 * Creates instance of the mutation handler.
	 *
	 * @param {engine.EditingController} editing
	 * @param {input.ChangeBuffer} buffer
	 */
	constructor( editing, buffer ) {
		/**
		 * The editing controller.
		 *
		 * @member {engine.EditingController} input.input.MutationHandler#editing
		 */
		this.editing = editing;

		/**
		 * The change buffer.
		 *
		 * @member {engine.EditingController} input.input.MutationHandler#buffer
		 */
		this.buffer = buffer;

		/**
		 * Number of inserted characters which need to be feed to the {@link #buffer change buffer}
		 * on {@link #commit}.
		 *
		 * @member {Number} input.input.MutationHandler#insertedCharacterCount
		 */
		this.insertedCharacterCount = 0;

		/**
		 * Position to which the selection should be moved on {@link #commit}.
		 *
		 * Note: Currently, the mutation handler will move selection to the position set by the
		 * last consumer. Placing the selection right after the last change will work for many cases, but not
		 * for ones like autocorrection or spellchecking. The caret should be placed after the whole piece
		 * which was corrected (e.g. a word), not after the letter that was replaced.
		 *
		 * @member {engine.model.Position} input.input.MutationHandler#selectionPosition
		 */
	}

	/**
	 * Handle given mutations.
	 *
	 * @param {Array.<engine.view.Document~MutatatedText|engine.view.Document~MutatatedChildren>} mutations
	 */
	handle( mutations ) {
		for ( let mutation of mutations ) {
			// Fortunately it will never be both.
			this._handleTextMutation( mutation );
			this._handleTextNodeInsertion( mutation );
		}

		this.buffer.input( Math.max( this.insertedCharacterCount, 0 ) );

		if ( this.selectionPosition ) {
			this.editing.model.selection.collapse( this.selectionPosition );
		}
	}

	_handleTextMutation( mutation ) {
		if ( mutation.type != 'text' ) {
			return;
		}

		const changes = diffToChanges( diff( mutation.oldText, mutation.newText ), mutation.newText );

		for ( let change of changes ) {
			const viewPos = new ViewPosition( mutation.node, change.index );
			const modelPos = this.editing.mapper.toModelPosition( viewPos );

			if ( change.type == 'INSERT' ) {
				const insertedText = change.values.join( '' );

				this._insert( modelPos, insertedText );

				this.selectionPosition = ModelPosition.createAt( modelPos.parent, modelPos.offset + insertedText.length );
			} else /* if ( change.type == 'DELETE' ) */ {
				this._remove( new ModelRange( modelPos, modelPos.getShiftedBy( change.howMany ) ), change.howMany );

				this.selectionPosition = modelPos;
			}
		}
	}

	_handleTextNodeInsertion( mutation ) {
		if ( mutation.type != 'children' ) {
			return;
		}

		// One new node.
		if ( mutation.newChildren.length - mutation.oldChildren.length != 1 ) {
			return false;
		}
		// Which is text.
		const changes = diffToChanges( diff( mutation.oldChildren, mutation.newChildren ), mutation.newChildren );
		const change = changes[ 0 ];

		if ( !( change.values[ 0 ] instanceof ViewText ) ) {
			return false;
		}

		const viewPos = new ViewPosition( mutation.node, change.index );
		const modelPos = this.editing.mapper.toModelPosition( viewPos );
		const insertedText = mutation.newChildren[ 0 ].data;

		this._insert( modelPos, insertedText );

		this.selectionPosition = ModelPosition.createAt( modelPos.parent, 'END' );
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

const safeKeycodes = [
	getCode( 'arrowUp' ),
	getCode( 'arrowRight' ),
	getCode( 'arrowDown' ),
	getCode( 'arrowLeft' ),
	16, // Shift
	17, // Ctrl
	18, // Alt
	20, // CapsLock
	27, // Escape
	33, // PageUp
	34, // PageDown
	35, // Home
	36, // End
];

// Function keys.
for ( let code = 112; code <= 135; code++ ) {
	safeKeycodes.push( code );
}

// Returns true if a keystroke should not cause any content change caused by "typing".
//
// Note: this implementation is very simple and will need to be refined with time.
//
// @param {engine.view.observer.keyObserver.KeyEventData} keyData
// @returns {Boolean}
function isSafeKeystroke( keyData ) {
	// Keystrokes which contain Ctrl don't represent typing.
	if ( keyData.ctrlKey ) {
		return true;
	}

	return safeKeycodes.includes( keyData.keyCode );
}
