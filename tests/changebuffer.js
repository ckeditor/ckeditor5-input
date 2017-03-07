/**
 * @license Copyright (c) 2003-2017, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

import ChangeBuffer from '../src/changebuffer';
import Document from '@ckeditor/ckeditor5-engine/src/model/document';
import Batch from '@ckeditor/ckeditor5-engine/src/model/batch';
import Position from '@ckeditor/ckeditor5-engine/src/model/position';

describe( 'ChangeBuffer', () => {
	const changeLimit = 3;
	let doc, buffer, root;

	beforeEach( () => {
		doc = new Document();
		root = doc.createRoot();
		buffer = new ChangeBuffer( doc, changeLimit );
	} );

	describe( 'constructor()', () => {
		it( 'sets all properties', () => {
			expect( buffer ).to.have.property( 'document', doc );
			expect( buffer ).to.have.property( 'limit', changeLimit );
			expect( buffer ).to.have.property( 'size', 0 );
		} );

		it( 'sets limit property according to default value', () => {
			buffer = new ChangeBuffer( doc );

			expect( buffer ).to.have.property( 'limit', 20 );
		} );
	} );

	describe( 'batch', () => {
		it( 'it is set initially', () => {
			expect( buffer ).to.have.property( 'batch' );
			expect( buffer.batch ).to.be.instanceof( Batch );
		} );

		it( 'is reset once changes reaches the limit', () => {
			const batch1 = buffer.batch;

			buffer.input( changeLimit - 1 );

			expect( buffer.batch ).to.equal( batch1 );

			buffer.input( 1 );

			const batch2 = buffer.batch;

			expect( batch2 ).to.be.instanceof( Batch );
			expect( batch2 ).to.not.equal( batch1 );
			expect( buffer.size ).to.equal( 0 );
		} );

		it( 'is reset once changes exceedes the limit', () => {
			const batch1 = buffer.batch;

			// Exceed the limit with one big jump to ensure that >= operator was used.
			buffer.input( changeLimit + 1 );

			expect( buffer.batch ).to.not.equal( batch1 );
			expect( buffer.size ).to.equal( 0 );
		} );

		it( 'is reset once a new batch appears in the document', () => {
			const batch1 = buffer.batch;

			// Ensure that size is reset too.
			buffer.input( 1 );

			doc.batch().insert( Position.createAt( root, 0 ), 'a' );

			expect( buffer.batch ).to.not.equal( batch1 );
			expect( buffer.size ).to.equal( 0 );
		} );

		it( 'is not reset when changes are added to the buffer\'s batch', () => {
			const batch1 = buffer.batch;

			buffer.batch.insert( Position.createAt( root, 0 ), 'a' );
			expect( buffer.batch ).to.equal( batch1 );

			buffer.batch.insert( Position.createAt( root, 0 ), 'b' );
			expect( buffer.batch ).to.equal( batch1 );
		} );

		it( 'is not reset when changes are added to batch which existed previously', () => {
			const externalBatch = doc.batch();

			externalBatch.insert( Position.createAt( root, 0 ), 'a' );

			const bufferBatch = buffer.batch;

			buffer.batch.insert( Position.createAt( root, 0 ), 'b' );
			expect( buffer.batch ).to.equal( bufferBatch );

			doc.batch().insert( Position.createAt( root, 0 ), 'c' );
			expect( buffer.batch ).to.not.equal( bufferBatch );
		} );

		it( 'is not reset when changes are applied in transparent batch', () => {
			const bufferBatch = buffer.batch;

			doc.batch( 'transparent' ).insert( Position.createAt( root, 0 ), 'a' );

			expect( buffer.batch ).to.equal( bufferBatch );
		} );
	} );

	describe( 'destroy', () => {
		it( 'offs the buffer from the document', () => {
			const batch1 = buffer.batch;

			buffer.destroy();

			doc.batch().insert( Position.createAt( root, 0 ), 'a' );

			expect( buffer.batch ).to.equal( batch1 );
		} );
	} );
} );
