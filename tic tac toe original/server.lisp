(load "/Users/chang/Anitgravity/Ace's/AIAces/.quicklisp/setup.lisp")
(ql:quickload :hunchentoot)
(ql:quickload :cl-json)

(defpackage :ttt-game
  (:use :cl :hunchentoot :cl-json))
(in-package :ttt-game)

(defvar *board* (make-array 9 :initial-element nil))
(defvar *current-player* "X")
(defvar *winner* nil)
(defvar *draw* nil)

(defun reset-game ()
  (setf *board* (make-array 9 :initial-element nil))
  (setf *current-player* "X")
  (setf *winner* nil)
  (setf *draw* nil))

(defun check-win ()
  (let ((winning-lines '((0 1 2) (3 4 5) (6 7 8)
                         (0 3 6) (1 4 7) (2 5 8)
                         (0 4 8) (2 4 6))))
    (some (lambda (line)
            (let ((a (aref *board* (first line)))
                  (b (aref *board* (second line)))
                  (c (aref *board* (third line))))
              (and a (string= a b) (string= a c) a)))
          winning-lines)))

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
     ("currentPlayer" . ,*current-player*)
     ("winner" . ,*winner*)
     ("draw" . ,(if *draw* t nil)))))

(define-easy-handler (api-move :uri "/api/move") (pos)
  (setf (content-type*) "application/json")
  (let ((p (parse-integer pos :junk-allowed t)))
    (when (and p (>= p 0) (<= p 8))
      (handle-move p)))
  (encode-json-to-string
   `(("status" . "ok"))))

(define-easy-handler (api-reset :uri "/api/reset") (starting)
  (setf (content-type*) "application/json")
  (reset-game)
  (when (and starting (or (string= starting "X") (string= starting "O")))
    (setf *current-player* starting))
  (encode-json-to-string
   `(("status" . "ok"))))

(defvar *server* nil)

(defun start-server ()
  (when *server* (stop *server*))
  (reset-game)
  (setf *server* (make-instance 'easy-acceptor :port 8085
                                :document-root #p"public/"))
  (start *server*)
  (format t "GUI Server started on http://localhost:8085~%"))

(start-server)

;; Keep the Lisp process alive
(loop (sleep 3600))
