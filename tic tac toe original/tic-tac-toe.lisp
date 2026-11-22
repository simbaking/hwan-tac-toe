;; tic-tac-toe.lisp
;; A simple command-line Tic Tac Toe game in Common Lisp

(defparameter *board* (make-array 9 :initial-element nil))

(defun print-board ()
  (format t "~% ~A | ~A | ~A~%" 
          (or (aref *board* 0) "1") 
          (or (aref *board* 1) "2") 
          (or (aref *board* 2) "3"))
  (format t "---+---+---~%")
  (format t " ~A | ~A | ~A~%" 
          (or (aref *board* 3) "4") 
          (or (aref *board* 4) "5") 
          (or (aref *board* 5) "6"))
  (format t "---+---+---~%")
  (format t " ~A | ~A | ~A~%" 
          (or (aref *board* 6) "7") 
          (or (aref *board* 7) "8") 
          (or (aref *board* 8) "9"))
  (format t "~%"))

(defun check-win (player)
  (let ((winning-lines '((0 1 2) (3 4 5) (6 7 8)   ; rows
                         (0 3 6) (1 4 7) (2 5 8)   ; cols
                         (0 4 8) (2 4 6))))        ; diagonals
    (some (lambda (line)
            (every (lambda (pos) (eql (aref *board* pos) player)) line))
          winning-lines)))

(defun check-draw ()
  (not (find nil *board*)))

(defun make-move (player)
  (loop
     (format t "Player ~A, enter your move (1-9): " player)
     (finish-output)
     (let ((input (read-line nil nil)))
       (when (not input) (return-from make-move nil)) ; Handle EOF
       (let ((move (parse-integer input :junk-allowed t)))
         (if (and move (>= move 1) (<= move 9) (null (aref *board* (1- move))))
             (progn
               (setf (aref *board* (1- move)) player)
               (return))
             (format t "Invalid move. Please choose an empty space between 1 and 9.~%"))))))

(defun play-game ()
  (setf *board* (make-array 9 :initial-element nil))
  (format t "Welcome to Tic Tac Toe!~%")
  (let ((current-player 'X))
    (loop
       (print-board)
       (make-move current-player)
       (cond
         ((check-win current-player)
          (print-board)
          (format t "Player ~A wins! Congratulations!~%" current-player)
          (return))
         ((check-draw)
          (print-board)
          (format t "It's a draw!~%")
          (return)))
       (setf current-player (if (eql current-player 'X) 'O 'X)))))

;; Start the game if the file is executed directly
(play-game)
