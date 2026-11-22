(load "/Users/chang/Anitgravity/Ace's/AIAces/.quicklisp/setup.lisp")
(ql:quickload :hunchentoot)
(ql:quickload :cl-json)

(defpackage :ttt-game-expand
  (:use :cl :hunchentoot :cl-json))
(in-package :ttt-game-expand)

(defvar *board-size* 3)
(defvar *board* (make-array (* *board-size* *board-size*) :initial-element nil))
(defvar *current-player* "X")
(defvar *winner* nil)
(defvar *draw* nil)
(defvar *x-handicap* 3)
(defvar *o-handicap* 3)
(defvar *x-blocks* 0)
(defvar *o-blocks* 0)

(defun reset-game (&optional (size *board-size*) x-hc o-hc x-bl o-bl)
  (setf *board-size* size)
  (setf *board* (make-array (* size size) :initial-element nil))
  (setf *current-player* "X")
  (setf *winner* nil)
  (setf *draw* nil)
  (setf *x-handicap* (or x-hc size))
  (setf *o-handicap* (or o-hc size))
  (setf *x-blocks* (or x-bl 0))
  (setf *o-blocks* (or o-bl 0)))

(defun get-val (r c)
  (if (and (>= r 0) (< r *board-size*) (>= c 0) (< c *board-size*))
      (aref *board* (+ (* r *board-size*) c))
      nil))

(defun check-win ()
  (let ((n *board-size*))
    (dotimes (r n)
      (dotimes (c n)
        (let ((val (get-val r c)))
          (when (or (string= val "X") (string= val "O"))
            (let ((req (if (string= val "X") *x-handicap* *o-handicap*)))
              (when (and req (<= req n)) ; only check if req makes sense
                ;; check 4 directions: right, down, down-right, up-right
                (let ((directions '((0 1) (1 0) (1 1) (-1 1))))
                  (dolist (dir directions)
                    (let ((dr (first dir))
                          (dc (second dir))
                          (win t))
                      (dotimes (step req)
                        (let ((nr (+ r (* dr step)))
                              (nc (+ c (* dc step))))
                          (unless (and (string= (get-val nr nc) val))
                            (setf win nil)
                            (return))))
                      (when win
                        (return-from check-win val)))))))))))
    nil))

(defun check-draw ()
  (not (position nil *board*)))

(defun handle-move (pos)
  (when (and (not *winner*) (not *draw*) (null (aref *board* pos)))
    (setf (aref *board* pos) *current-player*)
    (let ((win (check-win)))
      (if win
          (setf *winner* win)
          (if (check-draw)
              (setf *draw* t)
              (setf *current-player* (if (string= *current-player* "X") "O" "X")))))))

(define-easy-handler (api-state :uri "/api/state") ()
  (setf (content-type*) "application/json")
  (encode-json-to-string
   `(("board" . ,(coerce *board* 'list))
     ("boardSize" . ,*board-size*)
     ("currentPlayer" . ,*current-player*)
     ("winner" . ,*winner*)
     ("draw" . ,(if *draw* t nil))
     ("xHandicap" . ,*x-handicap*)
     ("oHandicap" . ,*o-handicap*)
     ("xBlocks" . ,*x-blocks*)
     ("oBlocks" . ,*o-blocks*))))

(define-easy-handler (api-move :uri "/api/move") (pos)
  (setf (content-type*) "application/json")
  (let ((p (parse-integer pos :junk-allowed t)))
    (when (and p (>= p 0) (< p (* *board-size* *board-size*)))
      (handle-move p)))
  (encode-json-to-string
   `(("status" . "ok"))))

(define-easy-handler (api-block :uri "/api/block") (pos)
  (setf (content-type*) "application/json")
  (let ((p (parse-integer pos :junk-allowed t)))
    (when (and p (>= p 0) (< p (* *board-size* *board-size*)))
      (when (and (not *winner*) (not *draw*) (null (aref *board* p)))
        (let ((blocks-left (if (string= *current-player* "X") *x-blocks* *o-blocks*)))
          (when (> blocks-left 0)
            (setf (aref *board* p) "B")
            (if (string= *current-player* "X")
                (decf *x-blocks*)
                (decf *o-blocks*))
            (if (check-draw)
                (setf *draw* t)))))))
  (encode-json-to-string
   `(("status" . "ok"))))

(define-easy-handler (api-reset :uri "/api/reset") (size starting xhc ohc xblocks oblocks)
  (setf (content-type*) "application/json")
  (let* ((sz-str size)
         (sz (if sz-str (parse-integer sz-str :junk-allowed t) *board-size*))
         (x-val (if xhc (parse-integer xhc :junk-allowed t) nil))
         (o-val (if ohc (parse-integer ohc :junk-allowed t) nil))
         (xb-val (if xblocks (parse-integer xblocks :junk-allowed t) nil))
         (ob-val (if oblocks (parse-integer oblocks :junk-allowed t) nil)))
    (if (and sz (>= sz 1) (<= sz 10)) ; increased limit a bit, or keep 5
        (reset-game sz x-val o-val xb-val ob-val)
        (reset-game *board-size* x-val o-val xb-val ob-val)))
  (when (and starting (or (string= starting "X") (string= starting "O")))
    (setf *current-player* starting))
  (encode-json-to-string
   `(("status" . "ok"))))

(defvar *server* nil)

(defun start-server ()
  (when *server* (stop *server*))
  (reset-game 3 3 3)
  (setf *server* (make-instance 'easy-acceptor :port 8086
                                :document-root #p"public/"))
  (start *server*)
  (format t "GUI Server started on http://localhost:8086~%"))

(start-server)

;; Keep the Lisp process alive
(loop (sleep 3600))
