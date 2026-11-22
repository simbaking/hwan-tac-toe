;; tic-tac-toe.lisp
;; A simple command-line Tic Tac Toe game in Common Lisp

(defparameter *board* (make-array 9 :initial-element nil))
(defparameter *x-handicap* 3)
(defparameter *o-handicap* 3)
(defparameter *x-blocks* 0)
(defparameter *o-blocks* 0)

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

(defun get-val (r c)
  (if (and (>= r 0) (< r 3) (>= c 0) (< c 3))
      (aref *board* (+ (* r 3) c))
      nil))

(defun check-win (player)
  (let ((req (if (eql player 'X) *x-handicap* *o-handicap*)))
    (if (and req (<= req 3))
        (dotimes (r 3)
          (dotimes (c 3)
            (let ((val (get-val r c)))
              (when (eql val player)
                (let ((directions '((0 1) (1 0) (1 1) (-1 1))))
                  (dolist (dir directions)
                    (let ((dr (first dir))
                          (dc (second dir))
                          (win t))
                      (dotimes (step req)
                        (let ((nr (+ r (* dr step)))
                          (nc (+ c (* dc step))))
                          (unless (eql (get-val nr nc) val)
                            (setf win nil)
                            (return))))
                      (when win
                        (return-from check-win t)))))))))
    nil)))

(defun check-draw ()
  (not (find nil *board*)))

(defun make-move (player blocks)
  (loop
     (if (> blocks 0)
         (format t "Player ~A, you have ~A block(s). Enter 'b' to use a block, or a number (1-9) for normal move: " player blocks)
         (format t "Player ~A, enter your move (1-9): " player))
     (finish-output)
     (let ((input (read-line nil nil)))
       (when (not input) (return-from make-move :eof)) ; Handle EOF
       (when (and (> blocks 0) (string-equal input "b"))
         (loop
           (format t "Player ~A, enter position to block (1-9): " player)
           (finish-output)
           (let ((b-input (read-line nil nil)))
             (when (not b-input) (return-from make-move :eof))
             (let ((b-move (parse-integer b-input :junk-allowed t)))
               (if (and b-move (>= b-move 1) (<= b-move 9) (null (aref *board* (1- b-move))))
                   (progn
                     (setf (aref *board* (1- b-move)) 'B)
                     (if (eql player 'X) (decf *x-blocks*) (decf *o-blocks*))
                     (print-board)
                     (return))
                   (format t "Invalid move. Please choose an empty space between 1 and 9.~%")))))
         (return-from make-move :block)) ; signal block was used, don't end turn
       (let ((move (parse-integer input :junk-allowed t)))
         (if (and move (>= move 1) (<= move 9) (null (aref *board* (1- move))))
             (progn
               (setf (aref *board* (1- move)) player)
               (return :move)) ; normal move used
             (format t "Invalid move. Please choose an empty space between 1 and 9.~%"))))))

(defun play-game ()
  (setf *board* (make-array 9 :initial-element nil))
  (format t "Welcome to Tic Tac Toe!~%")
  
  (format t "Enter handicap (win amount) for X (default 3): ")
  (finish-output)
  (let ((input (read-line nil nil)))
    (when (and input (not (string= input "")))
      (let ((val (parse-integer input :junk-allowed t)))
        (when (and val (>= val 1) (<= val 3))
          (setf *x-handicap* val)))))

  (format t "Enter handicap (win amount) for O (default 3): ")
  (finish-output)
  (let ((input (read-line nil nil)))
    (when (and input (not (string= input "")))
      (let ((val (parse-integer input :junk-allowed t)))
        (when (and val (>= val 1) (<= val 3))
          (setf *o-handicap* val)))))

  (format t "Enter blocks for X (max 3, default 0): ")
  (finish-output)
  (let ((input (read-line nil nil)))
    (when (and input (not (string= input "")))
      (let ((val (parse-integer input :junk-allowed t)))
        (when (and val (>= val 0) (<= val 3))
          (setf *x-blocks* val)))))

  (format t "Enter blocks for O (max 3, default 0): ")
  (finish-output)
  (let ((input (read-line nil nil)))
    (when (and input (not (string= input "")))
      (let ((val (parse-integer input :junk-allowed t)))
        (when (and val (>= val 0) (<= val 3))
          (setf *o-blocks* val)))))

  (let ((current-player 'X))
    (loop
       (print-board)
       (let ((blocks-left (if (eql current-player 'X) *x-blocks* *o-blocks*)))
         (let ((used-block (make-move current-player blocks-left)))
           (cond
             ((eql used-block :block)
              ;; block was used, same player gets to move again if they want
              (if (check-draw)
                  (progn
                    (print-board)
                    (format t "It's a draw!~%")
                    (return))))
             ((eql used-block :eof)
              ;; handle EOF
              (return))
             ((eql used-block :move)
              ;; normal move was made, check win/draw and swap player
              (cond
                ((check-win current-player)
                 (print-board)
                 (format t "Player ~A wins! Congratulations!~%" current-player)
                 (return))
                ((check-draw)
                 (print-board)
                 (format t "It's a draw!~%")
                 (return)))
              (setf current-player (if (eql current-player 'X) 'O 'X)))))))))

;; Start the game if the file is executed directly
(play-game)
