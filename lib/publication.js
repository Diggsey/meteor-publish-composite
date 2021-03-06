Publication = function Publication(subscription, options, args) {
    this.subscription = subscription;
    this.options = options;
    this.args = args || [];
    this.childrenOptions = options.children || [];
    this.publishedDocs = new PublishedDocumentList();
    this.collectionName = options.collectionName;
    this.internal = options.internal;
    this.projectionFn = LocalCollection._compileProjection(options.fields || {});
};

Publication.prototype.publish = function publish() {
    this.cursor = this._getCursor();

    if (!this.cursor) { return; }

    var collectionName = this._getCollectionName();
    var self = this;

    this.observeHandle = this.cursor.observe({
        added: function added(doc) {
            var alreadyPublished = self.publishedDocs.has(doc._id);

            if (alreadyPublished) {
                debugLog('Publication.observeHandle.added', collectionName + ':' + doc._id + ' already published');
                self.publishedDocs.unflagForRemoval(doc._id);
                if (!self.internal) {
                    self.subscription.changed(collectionName, doc._id, self.projectionFn(doc));
                }
                self._republishChildrenOf(doc);
            } else {
                self.publishedDocs.add(collectionName, doc._id);
                if (!self.internal) {
                    self.subscription.added(collectionName, self.projectionFn(doc));
                }
                self._publishChildrenOf(doc);
            }
        },
        changed: function changed(newDoc, oldDoc) {
            debugLog('Publication.observeHandle.changed', collectionName + ':' + newDoc._id);
            if (!self.internal) {
                projectedNew = self.projectionFn(newDoc);
                projectedOld = self.projectionFn(oldDoc);
                changedFields = LocalCollection._makeChangedFields(projectedNew, projectedOld);
                if (!_.isEmpty(changedFields)) {
                    self.subscription.changed(collectionName, newDoc._id, changedFields);
                }
            }
            self._republishChildrenOf(newDoc);
        },
        removed: function removed(doc) {
            debugLog('Publication.observeHandle.removed', collectionName + ':' + doc._id);
            self._removeDoc(collectionName, doc._id);
        }
    });
};

Publication.prototype.unpublish = function unpublish() {
    debugLog('Publication.unpublish', this._getCollectionName());
    this._stopObservingCursor();
    this._unpublishAllDocuments();
};

Publication.prototype._republish = function _republish() {
    this._stopObservingCursor();

    this.publishedDocs.flagAllForRemoval();

    debugLog('Publication._republish', 'run .publish again');
    this.publish();

    debugLog('Publication._republish', 'unpublish docs from old cursor');
    this._removeFlaggedDocs();
};

Publication.prototype._getCursor = function _getCursor() {
    return this.options.find.apply(this.subscription.meteorSub, this.args);
};

Publication.prototype._getCollectionName = function _getCollectionName() {
    return this.collectionName || (this.cursor && this.cursor._getCollectionName());
};

Publication.prototype._publishChildrenOf = function _publishChildrenOf(doc) {
    _.each(this.childrenOptions, function createChildPublication(options) {
        var pub = new Publication(this.subscription, options, [ doc ].concat(this.args));
        this.publishedDocs.addChildPub(doc._id, pub);
        pub.publish();
    }, this);
};

Publication.prototype._republishChildrenOf = function _republishChildrenOf(doc) {
    this.publishedDocs.eachChildPub(doc._id, function(publication) {
        publication.args[0] = doc;
        publication._republish();
    });
};

Publication.prototype._unpublishAllDocuments = function _unpublishAllDocuments() {
    this.publishedDocs.eachDocument(function(doc) {
        this._removeDoc(doc.collectionName, doc.docId);
    }, this);
};

Publication.prototype._stopObservingCursor = function _stopObservingCursor() {
    debugLog('Publication._stopObservingCursor', 'stop observing cursor');

    if (this.observeHandle) {
        this.observeHandle.stop();
        delete this.observeHandle;
    }
};

Publication.prototype._removeFlaggedDocs = function _removeFlaggedDocs() {
    this.publishedDocs.eachDocument(function(doc) {
        if (doc.isFlaggedForRemoval()) {
            this._removeDoc(doc.collectionName, doc.docId);
        }
    }, this);
};

Publication.prototype._removeDoc = function _removeDoc(collectionName, docId) {
    if (!this.internal) {
        this.subscription.removed(collectionName, docId);
    }
    this._unpublishChildrenOf(docId);
    this.publishedDocs.remove(docId);
};

Publication.prototype._unpublishChildrenOf = function _unpublishChildrenOf(docId) {
    debugLog('Publication._unpublishChildrenOf', 'unpublishing children of ' + this._getCollectionName() + ':' + docId);

    this.publishedDocs.eachChildPub(docId, function(publication) {
        publication.unpublish();
    });
};


var PublishedDocumentList = function() {
    this.documents = {};
};

PublishedDocumentList.prototype.add = function add(collectionName, docId) {
    var key = docId.valueOf();

    if (!this.documents[key]) {
        this.documents[key] = new PublishedDocument(collectionName, docId);
    }
};

PublishedDocumentList.prototype.addChildPub = function addChildPub(docId, publication) {
    if (!publication) { return; }

    var key = docId.valueOf();
    var doc = this.documents[key];

    if (typeof doc === 'undefined') {
        throw new Error('Doc not found in list: ' + key);
    }

    doc.addChildPub(publication);
};

PublishedDocumentList.prototype.get = function get(docId) {
    var key = docId.valueOf();
    return this.documents[key];
};

PublishedDocumentList.prototype.remove = function remove(docId) {
    var key = docId.valueOf();
    delete this.documents[key];
};

PublishedDocumentList.prototype.has = function has(docId) {
    return !!this.get(docId);
};

PublishedDocumentList.prototype.eachDocument = function eachDocument(callback, context) {
    _.each(this.documents, function execCallbackOnDoc(doc) {
        callback.call(this, doc);
    }, context || this);
};

PublishedDocumentList.prototype.eachChildPub = function eachChildPub(docId, callback) {
    var doc = this.get(docId);

    if (doc) {
        doc.eachChildPub(callback);
    }
};

PublishedDocumentList.prototype.getIds = function getIds() {
    var docIds = [];

    this.eachDocument(function(doc) {
        docIds.push(doc.docId);
    });

    return docIds;
};

PublishedDocumentList.prototype.unflagForRemoval = function unflagForRemoval(docId) {
    var doc = this.get(docId);

    if (doc) {
        doc.unflagForRemoval();
    }
};

PublishedDocumentList.prototype.flagAllForRemoval = function flagAllForRemoval() {
    this.eachDocument(function flag(doc) {
        doc.flagForRemoval();
    });
};


var PublishedDocument = function(collectionName, docId) {
    this.collectionName = collectionName;
    this.docId = docId;
    this.childPublications = [];
    this._isFlaggedForRemoval = false;
};

PublishedDocument.prototype.addChildPub = function addChildPub(childPublication) {
    this.childPublications.push(childPublication);
};

PublishedDocument.prototype.eachChildPub = function eachChildPub(callback) {
    for (var i = 0; i < this.childPublications.length; i++) {
        callback(this.childPublications[i]);
    }
};

PublishedDocument.prototype.isFlaggedForRemoval = function isFlaggedForRemoval() {
    return this._isFlaggedForRemoval;
};

PublishedDocument.prototype.unflagForRemoval = function unflagForRemoval() {
    this._isFlaggedForRemoval = false;
};

PublishedDocument.prototype.flagForRemoval = function flagForRemoval() {
    this._isFlaggedForRemoval = true;
};
