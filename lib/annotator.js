// Selection and range creation reference for the following code:
// http://www.quirksmode.org/dom/range_intro.html
//
// I've removed any support for IE TextRange (see commit d7085bf2 for code)
// for the moment, having no means of testing it.

(function($){
    
this.Annotator = DelegatorClass.extend({
    events: {
        '-adder img mousedown': 'showCreater',
        '-highlighter mouseover': 'highlightMouseover',
        '-highlighter mouseout': 'startViewerHideTimer',
        '-viewer mouseover': 'viewerMouseover',
        '-viewer mouseout': 'startViewerHideTimer',
        '-controls .edit click': 'controlEditClick',
        '-controls .del click': 'controlDeleteClick'
    },

    init: function (options, element) {
        var annotator = this;
        
        this.options = $.extend({
            // Class used to identify elements owned/created by the annotator.
            classPrefix: 'annot',

            adder:       "<div><a href='#'><img src='img/note.png' /></a></div>",
            creater:     "<div><textarea></textarea></div>",
            highlighter: "<span></span>",
            viewer:      "<div></div>"
        }, options);
        
        this.element = element;
        this.dom = {};
        
        this.addDelegatedEvent(this.element, 'mouseup', 'checkForSelection');

        // For all events beginning with '-', map them to a meaningful selector.
        // e.g. '-adder img click' -> '.annot-adder img click'
        $.each(this.events, function (k, v) {
            if (k.substr(0, 1) === '-') {
                annotator.events['.' + annotator.options.classPrefix + k] = v;
                delete annotator.events[k];
            }
        });

        // Bind delegated events.
        this._super();
        
        $.each(['adder', 'creater', 'highlighter', 'viewer'], function (idx, name) {
            annotator.dom[name] = $(annotator.options[name]).attr({ 
                'class': annotator.options.classPrefix + '-' + name
            }).appendTo(annotator.element).hide();
        });
    },

    checkForSelection: function (e) {
        // This prevents the note image from jumping away on the mouseup
        // of a click on icon.
        if (this.ignoreMouseup) {
            this.ignoreMouseup = false;
            return;
        } 
        
        this.getSelection();

        if (e && this.validSelection()) {
            this.dom.adder.show().css({
                top: e.pageY - 25,
                left: e.pageX + 3
            });
        } else {
            this.dom.adder.hide();
        }
    },
    
    getSelection: function () {
        // TODO: fail gracefully in IE. 
        this.selection = window.getSelection();
        this.selectedRanges = [];
        for(var ii = 0; ii < this.selection.rangeCount; ii += 1) {
            this.selectedRanges.push(this.selection.getRangeAt(ii));
        }
    },

    validSelection: function () {
        return this.selection && 
               this.selection.rangeCount > 0 && 
              !this.selection.isCollapsed;
    },

    createAnnotation: function (annotation) {
        var annotator = this;
        
        annotation = annotation || {};    
        annotation.highlights = annotation.highlights || [];

        annotation.ranges = $.map(annotation.ranges || this.selectedRanges, function (r) {
            var normed, serialized;

            if ("commonAncestorContainer" in r) {
                // range from a browser
                normed = annotator.normRange(r);
                serialized = annotator.serializeRange(normed);
            } else if (("start" in r) && (typeof r.start == "string")) {
                // serialized range
                normed = annotator.deserializeRange(r);
                serialized = r;
            } else {
                // presume normed
                normed = r;
                serialized = annotator.serializeRange(normed);
            }

            annotation.highlights = annotation.highlights.concat(annotator.highlightRange(normed));

            return serialized;
        });
        
        // Save the annotation data on each highlighter element.
        $(annotation.highlights).data('annotation', annotation);
        // Fire annotationCreated event so that others can react to it.
        $(this.element).trigger('annotationCreated', [this, annotation]);
       
        return annotation;
    },
    
    deleteAnnotation: function (annotation) {
        $.each(annotation.highlights, function () {
            $(this).replaceWith($(this).text());
        });
        $(this.element).trigger('annotationDeleted', [this, annotation]);
    },
    
    // normRange: works around the fact that browsers don't generate 
    // ranges/selections in a consistent manner. Some (Safari) will create 
    // ranges that have (say) a textNode startContainer and elementNode 
    // endContainer. Others (Firefox) seem to only ever generate 
    // textNode/textNode or elementNode/elementNode pairs. 
    //
    // This will return a (start, end, commonAncestor) triple, where start and 
    // end are textNodes, and commonAncestor is an elementNode.
    //
    // NB: This method may well split textnodes (i.e. alter the DOM) to 
    // achieve this.
    normRange: function (range) {
        var r = {}, nr = {};

        $.each(['start', 'end'], function (idx, p) {
            var it, node = range[p + 'Container'], offset = range[p + 'Offset'];

            if(node.nodeType === Node.ELEMENT_NODE) {
                // Get specified node.
                it = node.childNodes[offset];
                // If it doesn't exist, that means we need the end of the 
                // previous one.
                node = it || node.childNodes[offset - 1];
                while(node.nodeType !== Node.TEXT_NODE) { node = node.firstChild; }
                offset = it ? 0 : node.nodeValue.length;
            }

            r[p] = node;
            r[p + 'Offset'] = offset;
        });

        nr.start = (r.startOffset > 0) ? r.start.splitText(r.startOffset) : r.start;
        
        if (r.start === r.end) {
            if ((r.endOffset - r.startOffset) < nr.start.nodeValue.length)
                nr.start.splitText(r.endOffset - r.startOffset);
            nr.end = nr.start;
        } else {
            if (r.endOffset < r.end.nodeValue.length)
                r.end.splitText(r.endOffset);
            nr.end = r.end;
        }

        // Make sure the common ancestor is an element node.
        nr.commonAncestor = range.commonAncestorContainer;
        while(nr.commonAncestor.nodeType !== Node.ELEMENT_NODE) { 
            nr.commonAncestor = nr.commonAncestor.parentNode;
        }

        return nr;
    },

    // serializeRange: takes a normedRange and turns it into a 
    // serializedRange, which is two pairs of (xpath, character offset), which 
    // can be easily stored in a database and loaded through 
    // #loadAnnotations/#deserializeRange.
    serializeRange: function (normedRange) {
        var annotator = this;
        var serialization = function (node, isEnd) { 
            var origParent = $(node).parents(':not(.' + annotator.options.classPrefix + ')').eq(0),
                xpath = origParent.xpath(annotator.element)[0],
                textNodes = origParent.textNodes(),
                
                // Calculate real offset as the combined length of all the 
                // preceding textNode siblings. We include the length of the 
                // node if it's the end node.
                offset = $.inject(textNodes.slice(0, textNodes.index(node)), 
                                  0, 
                                  function (acc, tn) { return acc + tn.nodeValue.length; });

            return isEnd ? [xpath, offset + node.nodeValue.length] : [xpath, offset];
        },

        start = serialization(normedRange.start),
        end   = serialization(normedRange.end, true);

        return {
            // XPath strings
            start: start[0],
            end: end[0],
            // Character offsets (integer)
            startOffset: start[1],
            endOffset: end[1]
        };
    },

    deserializeRange: function (serializedRange) {
        var nodeFromXPath = function (xpath) {
            return document.evaluate( xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        };

        var parentXPath = $(this.element).xpath()[0],
            startAncestry = serializedRange.start.split("/"),
            endAncestry   = serializedRange.end.split("/"),
            common = [],
            range = {};

        // Crudely find a near common ancestor by walking down the XPath from 
        // the root until the segments no longer match.
        for (var ii = 0; ii < startAncestry.length; ii += 1) {
            if (startAncestry[ii] === endAncestry[ii]) {
                common.push(startAncestry[ii]);
            } else {
                break;
            }
        }

        range.commonAncestorContainer = nodeFromXPath(parentXPath + common.join("/"));

        // Unfortunately, we *can't* guarantee only one textNode per 
        // elementNode, so we have to walk along the element's textNodes until 
        // the combined length of the textNodes to that point exceeds or 
        // matches the value of the offset.
        $.each(['start', 'end'], function () {
            var which = this, length = 0;
            $(nodeFromXPath(parentXPath + serializedRange[this])).textNodes().each(function () {
                if (length + this.nodeValue.length >= serializedRange[which + 'Offset']) {
                    range[which + 'Container'] = this;
                    range[which + 'Offset'] = serializedRange[which + 'Offset'] - length;
                    return false; // end each loop.
                } else {
                    length += this.nodeValue.length;
                    return true;
                }
            });
        });

        return this.normRange(range);
    },

    highlightRange: function (normedRange) {
        var annotator = this;
        var textNodes = $(normedRange.commonAncestor).textNodes();
        var elemList = [];

        textNodes.slice(textNodes.index(normedRange.start), 
                        textNodes.index(normedRange.end) + 1).each(function () {
                      var wrapper = annotator.dom.highlighter.clone().show();
                      elemList.push($(this).wrap(wrapper).parent().get(0));
                  });

        return elemList;
    },

    loadAnnotations: function (annotations) {
        var annotator = this;
        $.each(annotations, function () {
            // Second parameter prevents events being fired when annotations 
            // are being loaded programmatically.
            annotator.createAnnotation(this);
        });
    },

    showCreater: function (e) {
        var annotator = this;

        this.dom.creater.css({
            top: e.pageY,
            left: e.pageX
        }).show().find('textarea').focus().bind('keydown', function (e) {
            if (e.keyCode == 27) {
                // "Escape" key: abort.
                $(this).val('').unbind().parent().hide();
            } else if (e.keyCode == 13 && !e.shiftKey) {
                // If "return" was pressed without the shift key, we're done.
                $(this).unbind().parent().hide();
                annotator.createAnnotation({ text: $(this).val() });
                $(this).val('');
            }
        }).bind('blur', function (e) {
            $(this).val('').unbind().parent().hide();
        });

        this.ignoreMouseup = true;
        this.dom.adder.hide();
        return false;
    },

    startViewerHideTimer: function (e) {
        // Allow 250ms for pointer to get from annotation to viewer to manipulate 
        // annotations.
        $(this).oneTime(250, "viewerHide", function () {
            this.dom.viewer.hide();
        });
    },
    
    highlightMouseover: function (e) {
        // Cancel any pending hiding of the viewer.
        $(this).stopTime("viewerHide");
        
        var items = $(e.target)
            .parents('.' + this.options.classPrefix + '-highlighter').andSelf();

        var controlsHTML = '<span class="' + this.options.classPrefix + '-controls">' +
                           '<a href="#" class="edit" alt="Edit" title="Edit this annotation">Edit</a>' + 
                           '<a href="#" class="del" alt="X" title="Delete this annotation">Delete</a></span>';

        var viewerclone = this.dom.viewer.clone().empty();
        
        $.each(items, function (idx, annot) {
            // As well as filling the viewer element, we also copy the annotation
            // object from the highlight element to the <p> containing the note 
            // and controls. This makes editing/deletion much easier.
            $('<p>' + $(annot).data("annotation").text + controlsHTML + '</p>')
                .appendTo(viewerclone)
                .data("annotation", $(annot).data("annotation"));
                
        });

        viewerclone.css({
            top: e.pageY + 2,
            left: e.pageX + 2
        }).replaceAll(this.dom.viewer).show();
        
        this.dom.viewer = viewerclone;
    },
    
    viewerMouseover: function (e) { 
        // Cancel any pending hiding of the viewer.
        $(this).stopTime("viewerHide");
    },
    
    controlEditClick: function (e) {
        console.log("Annotation editing: yet to be implemented.");
    },
    
    controlDeleteClick: function (e) {
        var para = $(e.target).parents('p');
        
        // Delete highlight elements.
        this.deleteAnnotation(para.data("annotation"));
        
        // Remove from viewer and hide viewer if this was the only annotation displayed.
        para.remove();
        if (!this.dom.viewer.is(':parent')) {
            this.dom.viewer.hide();
        }
    }
});

this.AnnotationStore = DelegatorClass.extend({
    events: {
        'annotationCreated': 'annotationCreated',
        'annotationDeleted': 'annotationDeleted'
    },

    init: function (options, element) {
        this.options = $.extend({
            prefix: '/store/annotations',
            urls: {
               'create': '',     // PUT/[POST]
               'read': '/:id',   // GET
               'update': '/:id', // POST/[PUT]
               'destroy': '/:id' // DELETE
            },
            annotator: $(element).data('annotator')
        }, options);

        // If the element on which we're instantiated doesn't already have an 
        // annotator instance, create one.
        if (!this.options.annotator) {
            $(element).annotator();
            this.options.annotator = $(element).data('annotator');
        }

        this.element = element;
        this.annotations = [];
        this.elementstore = {};

        this.loadAnnotations();

        this._super();
    },

    annotationCreated: function (e, annotator, annotation) {
        var self = this;
        
        // Pre-register the annotation so as to save the list of highlight 
        // elements.
        if ($.inArray(annotation, this.annotations) === -1) {        
            this.registerAnnotation(annotation);
            $.ajax({
                url: this._urlFor('create'),
                data: this._dataFor(annotation),
                dataType: 'jsonp',
                type: 'PUT',
                success: function (data) {
                    // Update with (e.g.) ID from server.
                    self.updateAnnotation(annotation, data);
                }
            });
        }
    },
    
    annotationDeleted: function (e, annotator, annotation) {
        console.log("AnnotationStore caught annotationDeleted event for annotation:", annotation);
    },

    registerAnnotation: function (annotation) {
        if ($.inArray(annotation, this.annotations) === -1) {
            this.annotations.push(annotation);
        }
    },
    
    updateAnnotation: function (annotation, data) {
        if ($.inArray(annotation, this.annotations) === -1) {
            console.error("Trying to update unregistered annotation!");
        } else {
            $.extend(annotation, data);
        }
        
        // Update the elements with our copies of the annotation objects (e.g. 
        // with ids from the server).
        $(annotation.highlights).data('annotation', annotation);
    },

    loadAnnotation: function (id) {
        // NB: null id loads all annotations.
        var self = this;
        $.getJSON(this._urlFor('read', id), null, function (data, textStatus) {
            if (textStatus === 'success') {
                self.annotations = id ? [data] : data;
                self.options.annotator.loadAnnotations(self.annotations);
            } else {
                throw('Annotation could not be loaded. [XHR returned "' + textStatus + '"]');
            }
        });
    },

    loadAnnotations: function () { this.loadAnnotation(null); },

    _urlFor: function (action, id) {
        var url = this.options.prefix ? this.options.prefix : '/';
        return url + this.options.urls[action].replace(/:id/, id || '');
    },
    
    _dataFor: function (annotation) {
        // Remove the list of highlight elements before passing back to the server.
        var _obj = $.evalJSON($.toJSON(annotation)); // Cheap deep clone.
        delete _obj.highlights;
        
        return {json: $.toJSON(_obj)};
    }
});

$.plugin('annotator', Annotator);
$.plugin('annotationStore', AnnotationStore);

})(jQuery);